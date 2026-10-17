-- Golem: lets an AI agent build in this Studio session.
-- Install: put Golem.rbxmx in Studio's Plugins folder, restart Studio.
-- Toolset reset: this build ships the session protocol only
-- (ping, debug, say, turn_begin, turn_end). Studio tools are added back on top.

if plugin == nil then
 warn("[Golem] This script must run as a Roblox Studio plugin.")
 return
end

local PLUGIN_TITLE = "Golem"
local VERSION = "4.0.0"
local FIREBASE_DB = "https://roblox-golem-default-rtdb.firebaseio.com"

local HttpService = game:GetService("HttpService")
local TweenService = game:GetService("TweenService")
local RunService = game:GetService("RunService")

local function getSetting(key, default)
 local value = plugin:GetSetting(key)
 if value == nil then
 return default
 end
 return value
end

local state = {
 connected = false,
 running = false,
 commandsServed = 0,
 errors = 0,
 workingCount = nil,
 startedAt = os.clock(),
}

local relay = {
 deviceId = nil,
 lastMsgId = nil,
 interval = 2,
 skipBefore = 0,
 okStreak = 0,
}

local function cmdUrl()
 return FIREBASE_DB .. "/channels/" .. tostring(relay.deviceId) .. "/cmd"
end

local function resUrl()
 return FIREBASE_DB .. "/channels/" .. tostring(relay.deviceId) .. "/res"
end

local ui = {}

local STUDIO_VERSION = "unknown"
do
 local ok, v = pcall(version)
 if ok and v ~= nil then
 STUDIO_VERSION = tostring(v)
 end
end

local COLORS = {

 bg = Color3.fromRGB(33, 33, 33),
 card = Color3.fromRGB(47, 47, 47),
 cardHi = Color3.fromRGB(58, 58, 65),
 inner = Color3.fromRGB(47, 47, 47),

 border = Color3.fromRGB(63, 63, 70),
 text = Color3.fromRGB(236, 236, 236),
 textDim = Color3.fromRGB(179, 179, 179),
 textFaint = Color3.fromRGB(142, 142, 147),
 live = Color3.fromRGB(16, 163, 127),
 warn = Color3.fromRGB(224, 169, 62),
 err = Color3.fromRGB(248, 113, 113),
 accent = Color3.fromRGB(16, 163, 127),
 neutral = Color3.fromRGB(47, 47, 47),


 dangerHi = Color3.fromRGB(122, 46, 46),
}

local COLORS_HEX = {
 live = "#10A37F",
 warn = "#FBBF24",
 err = "#F87171",
 dim = "#989DA7",
 text = "#ECECF1",
 faint = "#707580",

}

local fontRegular, fontMedium, fontSemibold, fontMono
do
 local ok = pcall(function()
 fontRegular = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Regular)
 fontMedium = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Medium)
 fontSemibold = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.SemiBold)
 end)
 if not ok then
 pcall(function()
 fontRegular = Font.fromEnum(Enum.Font.Gotham)
 fontMedium = Font.fromEnum(Enum.Font.GothamMedium)
 fontSemibold = Font.fromEnum(Enum.Font.GothamBold)
 end)
 end
 pcall(function()
 fontMono = Font.new("rbxasset://fonts/families/RobotoMono.json", Enum.FontWeight.Regular)
 end)
 if fontMono == nil then
 pcall(function()
 fontMono = Font.fromEnum(Enum.Font.Code)
 end)
 end
end

local function tween(inst, props, time, style)
 local t = TweenService:Create(inst,
 TweenInfo.new(time or 0.18, style or Enum.EasingStyle.Quad, Enum.EasingDirection.Out), props)
 t:Play()
 return t
end

local function createElement(className, props, parent)
 local inst = Instance.new(className)
 for key, value in pairs(props) do
 if key ~= "Parent" then
 inst[key] = value
 end
 end
 inst.Parent = parent
 return inst
end

local function addCorner(inst, radius)
 createElement("UICorner", { CornerRadius = UDim.new(0, radius or 8) }, inst)
end

local function log(message, kind)
 if kind == "err" then
 warn("[Golem] " .. tostring(message))
 else
 print("[Golem] " .. tostring(message))
 end
end

local function utf8Len(s)
 local ok, len = pcall(function()
 return utf8.len(s)
 end)
 if ok and len ~= nil then
 return len
 end
 return #s
end

local function utf8Head(s, chars)
 if chars <= 0 then
 return ""
 end
 local ok, idx = pcall(function()
 return utf8.offset(s, chars + 1)
 end)
 if ok then
 if idx == nil then
 return s
 end
 return string.sub(s, 1, idx - 1)
 end
 return string.sub(s, 1, chars)
end

local function truncateBytes(s, maxBytes)
 if #s <= maxBytes then
 return s
 end
 local n = maxBytes
 while n > 0 do
 local b = string.byte(s, n)
 if b == nil or b < 0x80 or b >= 0xC0 then
 break
 end
 n = n - 1
 end
 if n > 0 then
 local b = string.byte(s, n)
 if b ~= nil and b >= 0xC0 then
 local need = 2
 if b >= 0xF0 then
 need = 4
 elseif b >= 0xE0 then
 need = 3
 end
 if n + need - 1 > maxBytes then
 n = n - 1
 end
 end
 end
 return string.sub(s, 1, n)
end

local WORKING_QUOTES = {
 "Working…",
 "Talking to Studio…",
 "Waiting for the result…",
 "Checking the result…",
}
local quotesActive = false

task.spawn(function()
 local idx = 0
 while true do
 while not quotesActive do
 task.wait(0.25)
 end
 if ui.workText == nil then
 task.wait(1)
 else
 idx = idx + 1
 local quote = WORKING_QUOTES[(idx - 1) % #WORKING_QUOTES + 1]
 local quoteLen = utf8Len(quote)
 for i = 0, quoteLen do
 if not quotesActive then
 break
 end
 ui.workText.Text = utf8Head(quote, i)
 task.wait(0.028)
 end
 local held = 0
 while quotesActive and held < 2.0 do
 held = held + 0.1
 task.wait(0.1)
 end
 for i = quoteLen, 0, -1 do
 if not quotesActive then
 break
 end
 ui.workText.Text = utf8Head(quote, i)
 task.wait(0.022)
 end
 if quotesActive then
 task.wait(0.2)
 end
 end
 end
end)

local function updateStatus()
 if ui.statusDot ~= nil then
 local live = state.running and state.connected
 local dotColor, text
 local working = live and state.publishError == nil
 and type(state.workingCount) == "number"
 if live and state.publishError ~= nil then

 dotColor, text = COLORS.warn, "LIVE · ISSUES"
 elseif working then

 dotColor = COLORS.accent
 text = nil
 elseif live then
 dotColor, text = COLORS.live, "LIVE"
 elseif state.running then
 dotColor, text = COLORS.warn, "CONNECTING…"
 else
 dotColor, text = COLORS.textFaint, "OFFLINE"
 end
 quotesActive = working
 if text ~= nil then
 ui.statusText.Text = text
 end
 ui.statusText.TextColor3 = live and COLORS.text or COLORS.textDim

 if ui.statusDot.BackgroundColor3 ~= dotColor then
 tween(ui.statusDot, { BackgroundColor3 = dotColor }, 0.3)
 end
 end
end

local function setConnected(connected, err)
 if state.connected ~= connected then
 state.connected = connected
 if connected then
 log("Connection established.")
 else
 log("Disconnected" .. (err ~= nil and err ~= "" and (": " .. tostring(err)) or ""))
 end
 end
 updateStatus()
end

local OP_LABELS = {
 ping = "Checking",
 debug = "Running diagnostics",
 say = "Saying",
}

local function describeArgs(op, args)
 if type(args) ~= "table" then
 return ""
 end
 local value = args.path or args.query or args.text
 if type(value) ~= "string" then
 return ""
 end
 return value
end
local function richEscape(s)
 s = string.gsub(tostring(s), "&", "&amp;")
 s = string.gsub(s, "<", "&lt;")
 s = string.gsub(s, ">", "&gt;")
 return s
end
local activeDotSets = {}
local dotsPhase = 0.0
local dotsConn = nil

local function dotsHeartbeat(dt)
 dotsPhase = (dotsPhase + dt * 2.2) % (math.pi * 2)
 for _, set in ipairs(activeDotSets) do
 for i, dot in ipairs(set) do
 local phase = (dotsPhase - (i - 1) * 0.55) % (math.pi * 2)
 local s = (math.sin(phase) + 1) / 2
 dot.BackgroundTransparency = 0.15 + 0.65 * (1 - s)
 dot.Size = UDim2.fromOffset(4 + 4 * s, 4 + 4 * s)
 end
 end
end

local function dotsAttach(set)
 table.insert(activeDotSets, set)
 if dotsConn == nil then
 dotsConn = RunService.Heartbeat:Connect(dotsHeartbeat)
 end
end

local function dotsDetach(set)
 for i, existing in ipairs(activeDotSets) do
 if existing == set then
 table.remove(activeDotSets, i)
 break
 end
 end
 for _, dot in ipairs(set) do
 dot.BackgroundTransparency = 1
 end
 if #activeDotSets == 0 and dotsConn ~= nil then
 dotsConn:Disconnect()
 dotsConn = nil
 end
end

local chatHistory = {}
local chatPersistScheduled = false
local CHAT_HISTORY_MAX = 40
local RESTORE_MAX_ENTRIES = 60

local function chatPlaceKey()
 if game.PlaceId ~= nil and game.PlaceId ~= 0 then
 return "AIBridge_Chat_" .. tostring(game.PlaceId)
 end
 local name = string.gsub(tostring(game.Name), "[^%w-_]", "_")
 return "AIBridge_Chat_local_" .. name
end

function chatPersistNow()
 local ok, encoded = pcall(function()
 return HttpService:JSONEncode(chatHistory)
 end)
 if ok then
 pcall(function()
 plugin:SetSetting(chatPlaceKey(), encoded)
 end)
 end
end

local function chatPersist()
 if chatPersistScheduled then
 return
 end
 chatPersistScheduled = true
 task.delay(1.5, function()
 chatPersistScheduled = false
 chatPersistNow()
 end)
end

local function chatPush(entry)
 table.insert(chatHistory, entry)
 while #chatHistory > CHAT_HISTORY_MAX * 4 do
 table.remove(chatHistory, 1)
 end
 chatPersist()
end

function chatRestore()
 local stored = getSetting(chatPlaceKey(), nil)
 if type(stored) ~= "string" or #stored == 0 then
 return
 end
 local ok, data = pcall(function()
 return HttpService:JSONDecode(stored)
 end)
 if not ok or type(data) ~= "table" then
 return
 end

 local total = #data
 local skipped = math.max(0, total - RESTORE_MAX_ENTRIES)
 if skipped > 0 then
 local tail = table.create(RESTORE_MAX_ENTRIES)
 for i = skipped + 1, total do
 table.insert(tail, data[i])
 end
 data = tail
 end
 chatHistory = data
 if skipped > 0 then
 chatPersistNow()
 end
 for _, entry in ipairs(data) do
 if type(entry) == "table" then
 if entry.k == "m" and type(entry.t) == "string" then
 addChatMessage(entry.t, false)
 elseif entry.k == "c" and type(entry.op) == "string" then
 addChatCommand(entry.op, nil, entry)
 end
 end
 end
 chatFlushTurn()
 if skipped > 0 then
 log(string.format("Restored the newest %d of %d saved entries (older history unloaded).", #data, total))
 else
 log("Restored chat history for this place.")
 end
end

local scrollTween = nil

local function chatMaxScroll()
 local frame = ui.chatFrame
 if frame == nil then
 return 0
 end
 return math.max(0, frame.AbsoluteCanvasSize.Y - frame.AbsoluteWindowSize.Y)
end

local function isPinned()
 return (chatMaxScroll() - (ui.chatFrame.CanvasPosition.Y)) <= 100
end

local function smoothScrollToBottom()
 local frame = ui.chatFrame
 if frame == nil then
 return
 end
 local target = chatMaxScroll()
 if target <= 0 then
 return
 end
 if scrollTween ~= nil then
 scrollTween:Cancel()
 end
 scrollTween = tween(frame, { CanvasPosition = Vector2.new(0, target) }, 0.22)
end

local function chatFollowRaw()
 if ui.chatFrame ~= nil and isPinned() then
 ui.chatFrame.CanvasPosition = Vector2.new(0, chatMaxScroll())
 end
end

local function chatUpdatePill()
 if ui.jumpPill == nil or ui.chatFrame == nil then
 return
 end
 local shouldShow = chatMaxScroll() > 140 and not isPinned()
 if shouldShow ~= ui.jumpPill.Visible then
 ui.jumpPill.Visible = shouldShow
 if shouldShow then
 ui.jumpPill.BackgroundTransparency = 0.5
 ui.jumpPill.TextTransparency = 0.5
 tween(ui.jumpPill, { BackgroundTransparency = 0, TextTransparency = 0 }, 0.18)
 end
 end
end

local function chatScroll(force)
 if ui.chatFrame == nil then
 return
 end
 if force or isPinned() then
 task.defer(smoothScrollToBottom)
 task.defer(chatUpdatePill)
 else
 chatUpdatePill()
 end
end

local function typeOutRow(row, buildText, totalChars, onDone)
 task.spawn(function()
 if totalChars <= 0 then
 row.Text = buildText(0, true)
 if onDone then
 onDone()
 end
 return
 end
 local steps = math.clamp(math.ceil(totalChars / 2), 14, 40)
 for i = 0, steps do
 local reveal = math.floor(totalChars * i / steps)
 row.Text = buildText(reveal, i == steps)
 chatFollowRaw()
 if i < steps then
 task.wait(0.03)
 end
 end
 if onDone then
 onDone()
 end
 end)
end

local function streamLabel(label, full)
 task.spawn(function()
 local total = utf8Len(full)
 if total <= 0 then
 label.Text = full
 return
 end
 local steps = math.clamp(math.ceil(total / 24), 1, 40)
 for i = 0, steps do
 label.Text = utf8Head(full, math.floor(total * i / steps))
 chatFollowRaw()
 if i < steps then
 task.wait(0.025)
 end
 end
 end)
end

local function heightSize(clip, h)
 local x = clip.Size.X
 return UDim2.new(x.Scale, x.Offset, 0, h)
end

local function expandContainer(clip, content, onDone)
 clip.Visible = true
 clip.Size = heightSize(clip, 0)
 if clip:IsA("CanvasGroup") then
 clip.GroupTransparency = 1
 end
 task.defer(function()
 local t = tween(clip, { Size = heightSize(clip, math.ceil(content.AbsoluteSize.Y)) }, 0.3, Enum.EasingStyle.Quint)
 if clip:IsA("CanvasGroup") then
 tween(clip, { GroupTransparency = 0 }, 0.25)
 end
 t.Completed:Connect(function(playback)

 if playback == Enum.PlaybackState.Completed then
 local now = math.ceil(content.AbsoluteSize.Y)
 if math.abs(clip.Size.Y.Offset - now) > 1 then
 tween(clip, { Size = heightSize(clip, now) }, 0.15)
 end
 end
 if onDone then
 onDone()
 end
 end)
 end)
end

local function collapseContainer(clip, onDone)
 local t = tween(clip, { Size = heightSize(clip, 0) }, 0.24, Enum.EasingStyle.Quint)
 if clip:IsA("CanvasGroup") then
 tween(clip, { GroupTransparency = 1 }, 0.2)
 end
 t.Completed:Connect(function()
 clip.Visible = false
 if clip:IsA("CanvasGroup") then
 clip.GroupTransparency = 0
 end
 if onDone then
 onDone()
 end
 end)
end

local TURN_AUTO_IDLE_SECONDS = 120
local TURN_EXPLICIT_IDLE_SECONDS = 300
local chatOrder = 0
local chatQueue = {}
local currentTurn = nil
local abandonedTurn = nil

local refreshWorking

local function chatTrim(holder)
 table.insert(chatQueue, holder)
 local liveHolder = currentTurn and currentTurn.holder or nil
 while #chatQueue > CHAT_HISTORY_MAX do
 local oldest = table.remove(chatQueue, 1)
 if oldest ~= nil and oldest ~= liveHolder then
 oldest:Destroy()
 end
 end
end

local function chatHideEmpty()
 if ui.chatEmpty ~= nil and ui.chatEmpty.Visible then
 ui.chatEmpty.Visible = false
 end

 if ui.setupPill ~= nil and ui.setupPill.Visible then
 ui.setupPill.Visible = false
 end
 if ui.setupPopup ~= nil and ui.setupPopup.Visible and ui.hideSetupPopup ~= nil then
 ui.hideSetupPopup()
 end
end

local function turnSummaryText(turn, expanded)
 local meta = ""
 if turn.clockText ~= nil then
 meta = string.format(' <font color="%s">· %s · %s</font>',
 COLORS_HEX.faint, turn.elapsedText or "?", turn.clockText)
 end
 return string.format('<font color="%s">Tool Used: %d</font>%s <font color="%s">%s</font>',
 COLORS_HEX.dim, turn.count, meta, COLORS_HEX.faint, expanded and "∨" or "›")
end

local function collapseTurn(turn)
 if turn == nil or turn.collapsed then
 return
 end
 turn.elapsedText = string.format("%ds",
 math.max(1, math.floor(os.clock() - (turn.startedAt or os.clock()))))
 turn.clockText = os.date("%H:%M")
 if turn.count == 0 then

 if currentTurn == turn then
 currentTurn = nil
 end
 turn.holder:Destroy()
 if refreshWorking ~= nil then
 refreshWorking()
 end
 chatScroll()
 return
 end
 turn.collapsed = true
 turn.expanded = false
 if currentTurn == turn then
 currentTurn = nil
 end
 local summary = createElement("TextButton", {
 Size = UDim2.new(1, 0, 0, 22),
 BackgroundTransparency = 1,
 BorderSizePixel = 0,
 AutoButtonColor = false,
 RichText = true,
 FontFace = fontMedium,
 TextSize = 13,
 TextXAlignment = Enum.TextXAlignment.Left,
 Text = turnSummaryText(turn, false),
 TextTransparency = 1,
 LayoutOrder = 1,
 }, turn.holder)
 summary.Activated:Connect(function()
 if turn.expanded then
 turn.expanded = false
 collapseContainer(turn.clip)
 summary.Text = turnSummaryText(turn, false)
 else
 turn.expanded = true
 expandContainer(turn.clip, turn.rows, chatScroll)
 summary.Text = turnSummaryText(turn, true)
 end
 chatScroll()
 end)
 tween(summary, { TextTransparency = 0 }, 0.25)
 collapseContainer(turn.clip)
 chatScroll()
 if refreshWorking ~= nil then
 refreshWorking()
 end
end

function chatFlushTurn()
 if currentTurn ~= nil then
 collapseTurn(currentTurn)
 end
end

local function scheduleCollapse(turn)
 turn.gen = (turn.gen or 0) + 1
 local myGen = turn.gen
 local idle = turn.explicit and TURN_EXPLICIT_IDLE_SECONDS or TURN_AUTO_IDLE_SECONDS
 task.delay(idle, function()
 if currentTurn == turn and turn.gen == myGen and not turn.collapsed then
 if turn.count > 0 then
 abandonedTurn = { count = turn.count }
 end
 collapseTurn(turn)
 end
 end)
end

local function beginTurn()
 if currentTurn ~= nil then
 currentTurn.gen = (currentTurn.gen or 0) + 1
 return currentTurn
 end
 chatOrder = chatOrder + 1
 local turnHolder = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 LayoutOrder = chatOrder,
 }, ui.chatFrame)
 createElement("UIListLayout", {
 Padding = UDim.new(0, 2),
 SortOrder = Enum.SortOrder.LayoutOrder,
 }, turnHolder)

 local clip = createElement("CanvasGroup", {
 Size = UDim2.new(1, 0, 0, 0),
 BackgroundTransparency = 1,
 BorderSizePixel = 0,
 ClipsDescendants = true,
 GroupTransparency = 0,
 LayoutOrder = 2,
 }, turnHolder)
 local rowsFrame = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 }, clip)
 createElement("UIListLayout", {
 Padding = UDim.new(0, 4),
 SortOrder = Enum.SortOrder.LayoutOrder,
 }, rowsFrame)
 local turn = {
 holder = turnHolder, clip = clip, rows = rowsFrame,
 count = 0, gen = 0, collapsed = false, expanded = true,
 startedAt = os.clock(),
 }

 rowsFrame:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
 if turn.expanded then
 tween(clip, { Size = heightSize(clip, math.ceil(rowsFrame.AbsoluteSize.Y)) }, 0.14)
 end
 end)
 currentTurn = turn
 if refreshWorking ~= nil then
 refreshWorking()
 end
 chatTrim(turnHolder)
 return turn
end

local bannerShown = false
refreshWorking = function()

 local working = (currentTurn ~= nil and not currentTurn.collapsed)
 if working then
 state.workingCount = currentTurn.count
 else
 state.workingCount = nil
 end
 if ui.workBanner ~= nil and ui.chatFrame ~= nil then
 local n = state.workingCount or 0
 ui.workCount.Text = string.format("%d TOOL%s", n, n == 1 and "" or "S")

 if working and not bannerShown then
 bannerShown = true
 if not ui.workBanner.Visible then
 ui.workBanner.Visible = true
 ui.workBanner.BackgroundTransparency = 1
 ui.workText.TextTransparency = 1
 ui.workCount.TextTransparency = 1
 ui.workDot.BackgroundTransparency = 1
 end
 tween(ui.workBanner, { BackgroundTransparency = 0 }, 0.25)
 tween(ui.workText, { TextTransparency = 0 }, 0.25)
 tween(ui.workCount, { TextTransparency = 0.25 }, 0.25)
 tween(ui.workDot, { BackgroundTransparency = 0 }, 0.25)
 tween(ui.chatFrame, { Position = UDim2.new(0, 16, 0, 96), Size = UDim2.new(1, -32, 1, -112) }, 0.28)
 elseif not working and bannerShown then
 bannerShown = false
 tween(ui.workBanner, { BackgroundTransparency = 1 }, 0.25)
 tween(ui.workText, { TextTransparency = 1 }, 0.25)
 tween(ui.workCount, { TextTransparency = 1 }, 0.25)
 tween(ui.workDot, { BackgroundTransparency = 1 }, 0.25)
 tween(ui.chatFrame, { Position = UDim2.new(0, 16, 0, 56), Size = UDim2.new(1, -32, 1, -72) }, 0.28)
 task.delay(0.26, function()
 if ui.workBanner ~= nil and state.workingCount == nil then
 ui.workBanner.Visible = false
 end
 end)
 end
 end
 updateStatus()
end

function addChatMessage(text, animate, closeTurn)

 if ui.chatFrame == nil then
 return
 end
 local isLive = (animate ~= false)
 local close = (closeTurn ~= false)
 local turn = currentTurn

 local holder
 local noteOrder = 3

 if turn ~= nil and (turn.count > 0 or not close) then
 holder = turn.holder
 if close then
 collapseTurn(turn)
 else

 turn.notes = (turn.notes or 0) + 1
 noteOrder = 10000 + turn.notes
 turn.gen = (turn.gen or 0) + 1
 scheduleCollapse(turn)
 end
 else
 if turn ~= nil then
 currentTurn = nil
 turn.holder:Destroy()
 end
 chatOrder = chatOrder + 1
 holder = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 LayoutOrder = chatOrder,
 }, ui.chatFrame)
 chatTrim(holder)
 end

 local full = tostring(text)

 local message = createElement("TextBox", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 RichText = true,
 FontFace = fontRegular,
 TextSize = 14,
 TextWrapped = true,
 MultiLine = true,
 TextEditable = false,
 ClearTextOnFocus = false,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextYAlignment = Enum.TextYAlignment.Top,
 TextColor3 = COLORS.text,
 Text = richEscape(full),
 TextTransparency = isLive and 1 or 0,
 LayoutOrder = noteOrder,
 }, holder)
 createElement("UIPadding", {
 PaddingLeft = UDim.new(0, 4),
 PaddingRight = UDim.new(0, 4),
 PaddingTop = UDim.new(0, 2),
 PaddingBottom = UDim.new(0, 2),
 }, message)
 if isLive then

 task.spawn(function()
 local total = utf8Len(full)
 local steps = math.clamp(math.ceil(total / 3), 12, 48)
 for i = 0, steps do
 local partial = utf8Head(full, math.floor(total * i / steps))
 message.Text = richEscape(partial)
 message.TextTransparency = 0
 chatFollowRaw()
 if i < steps then
 task.wait(0.025)
 end
 end
 end)
 chatPush({ k = "m", t = full })
 end
 if refreshWorking ~= nil then
 refreshWorking()
 end
 chatHideEmpty()
 chatScroll()
end

function addChatCommand(opName, args, replay)
 if ui.chatFrame == nil then
 return nil
 end
 if opName == "turn_begin" or opName == "turn_end" then

 return nil
 end
 local turn = beginTurn()
 turn.count = turn.count + 1
 if refreshWorking ~= nil then
 refreshWorking()
 end
 local descText = (replay ~= nil) and tostring(replay.d or "") or describeArgs(opName, args)
 if #descText > 48 then
 descText = truncateBytes(descText, 46) .. "…"
 end

 local holder = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 LayoutOrder = turn.count,
 }, turn.rows)

 local row = createElement("TextButton", {
 Size = UDim2.new(1, 0, 0, 26),
 BackgroundColor3 = COLORS.card,
 BackgroundTransparency = 1,
 BorderSizePixel = 0,
 AutoButtonColor = false,
 RichText = true,
 FontFace = fontRegular,
 TextSize = 14,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextColor3 = COLORS.textDim,
 Text = "",
 TextTransparency = (replay == nil) and 1 or 0,
 }, holder)
 row.MouseEnter:Connect(function()
 tween(row, { BackgroundTransparency = 0.88 }, 0.12)
 end)
 row.MouseLeave:Connect(function()
 tween(row, { BackgroundTransparency = 1 }, 0.2)
 end)

 local dotsFrame = createElement("Frame", {
 BackgroundTransparency = 1,
 AnchorPoint = Vector2.new(1, 0.5),
 Position = UDim2.new(1, -10, 0.5, 0),
 Size = UDim2.fromOffset(42, 16),
 }, row)
 createElement("UIListLayout", {
 FillDirection = Enum.FillDirection.Horizontal,
 Padding = UDim.new(0, 6),
 SortOrder = Enum.SortOrder.LayoutOrder,
 VerticalAlignment = Enum.VerticalAlignment.Center,
 HorizontalAlignment = Enum.HorizontalAlignment.Right,
 }, dotsFrame)
 local dots = {}
 for i = 1, 3 do
 local dot = createElement("Frame", {
 Size = UDim2.fromOffset(5, 5),
 BackgroundColor3 = COLORS.accent,
 BorderSizePixel = 0,
 BackgroundTransparency = 1,
 LayoutOrder = i,
 }, dotsFrame)
 addCorner(dot, 4)
 dots[i] = dot
 end

 local detail = createElement("Frame", {
 Position = UDim2.new(0, 10, 0, 26),
 Size = UDim2.new(1, -10, 0, 0),
 BackgroundColor3 = COLORS.inner,
 BorderSizePixel = 0,
 ClipsDescendants = true,
 Visible = false,
 }, holder)
 addCorner(detail, 6)
 local detailInner = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 }, detail)
 createElement("UIListLayout", {
 Padding = UDim.new(0, 6),
 SortOrder = Enum.SortOrder.LayoutOrder,
 }, detailInner)
 createElement("UIPadding", {
 PaddingTop = UDim.new(0, 10),
 PaddingBottom = UDim.new(0, 10),
 PaddingLeft = UDim.new(0, 12),
 PaddingRight = UDim.new(0, 12),
 }, detailInner)

 local function detailLabel(order, text, color)
 return createElement("TextLabel", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 FontFace = fontMono,
 TextSize = 13,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextYAlignment = Enum.TextYAlignment.Top,
 TextWrapped = true,
 TextColor3 = color or COLORS.textDim,
 Text = text,
 LayoutOrder = order,
 }, detailInner)
 end

 createElement("TextLabel", {
 Size = UDim2.new(1, 0, 0, 12),
 BackgroundTransparency = 1,
 FontFace = fontSemibold,
 TextSize = 11,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextColor3 = COLORS.textFaint,
 Text = "REQUEST",
 LayoutOrder = 1,
 }, detailInner)
 local argsLabel = detailLabel(2, "{}")
 createElement("TextLabel", {
 Size = UDim2.new(1, 0, 0, 12),
 BackgroundTransparency = 1,
 FontFace = fontSemibold,
 TextSize = 11,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextColor3 = COLORS.textFaint,
 Text = "RESULT",
 LayoutOrder = 3,
 }, detailInner)
 local resultLabel = detailLabel(4, "…")

 local function rowText(glyph, glyphHex, desc, msText)
 local verb = OP_LABELS[opName] or tostring(opName)
 local text = string.format('<font color="%s">%s</font> <font color="%s">%s</font>',
 glyphHex, glyph, COLORS_HEX.dim, richEscape(verb))
 if desc ~= nil and #desc > 0 then
 text = text .. string.format(' <font color="%s">%s</font>', COLORS_HEX.text, richEscape(desc))
 end
 if msText ~= nil then
 text = text .. string.format(' <font color="%s">· %s</font>', COLORS_HEX.faint, msText)
 end
 return text
 end

 local detailOpen = false
 local function openDetail()
 detailOpen = true
 expandContainer(detail, detailInner, chatScroll)
 end
 local function closeDetail()
 detailOpen = false
 collapseContainer(detail)
 end

 detailInner:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
 if detailOpen and detail.Visible then
 tween(detail, { Size = heightSize(detail, math.ceil(detailInner.AbsoluteSize.Y)) }, 0.12)
 end
 end)

 row.Activated:Connect(function()
 if detailOpen then
 closeDetail()
 else
 openDetail()
 end
 chatScroll()
 end)

 if replay ~= nil then

 local ok = replay.ok ~= false
 row.Text = rowText(ok and "•" or "•", ok and COLORS_HEX.live or COLORS_HEX.err,
 descText, (tostring(tonumber(replay.ms) or 0)) .. " ms")
 argsLabel.Text = tostring(replay.a or "{}")
 resultLabel.Text = tostring(replay.r or "")
 if not ok then
 resultLabel.TextColor3 = COLORS.err
 end
 chatHideEmpty()
 return nil
 end

 dotsAttach(dots)
 row.Text = rowText("●", COLORS_HEX.warn, "", nil)
 tween(row, { TextTransparency = 0 }, 0.2)
 typeOutRow(row, function(reveal, done)
 return rowText("●", COLORS_HEX.warn, utf8Head(descText, reveal), nil)
 end, utf8Len(descText))
 chatHideEmpty()
 chatScroll()

 local argsJson = "{}"
 pcall(function()
 argsJson = HttpService:JSONEncode(type(args) == "table" and args or {})
 end)
 if #argsJson > 600 then
 argsJson = truncateBytes(argsJson, 600) .. "…"
 end
 argsLabel.Text = argsJson

 local handle = {}

 function handle.finish(envelope)
 local ms = tonumber(envelope.meta and envelope.meta.durationMs) or 0
 local resultText
 if envelope.ok then
 resultText = "{}"
 pcall(function()
 resultText = HttpService:JSONEncode(envelope.result)
 end)
 if #resultText > 900 then
 resultText = truncateBytes(resultText, 900) .. "\n… (truncated — ask the AI or narrow the request)"
 end
 if detailOpen then
 streamLabel(resultLabel, resultText)
 else
 resultLabel.Text = resultText
 end

 typeOutRow(row, function(reveal, done)
 return rowText("•", COLORS_HEX.live, utf8Head(descText, reveal),
 done and (tostring(ms) .. " ms") or nil)
 end, utf8Len(descText), function()
 dotsDetach(dots)
 end)
 else
 resultText = tostring(envelope.error or "")
 if #resultText > 700 then
 resultText = truncateBytes(resultText, 700) .. "…"
 end
 resultLabel.TextColor3 = COLORS.err
 openDetail()
 streamLabel(resultLabel, resultText)
 typeOutRow(row, function(reveal, done)
 return rowText("•", COLORS_HEX.err, utf8Head(descText, reveal), nil)
 end, utf8Len(descText), function()
 dotsDetach(dots)
 end)
 end
 chatPush({
 k = "c", op = tostring(opName), d = descText, a = argsJson,
 r = resultText, ok = envelope.ok, ms = ms,
 })
 scheduleCollapse(turn)
 chatScroll()
 end

 return handle
end

local http

local OPS = {}

function OPS.ping()
 return {
 ok = true,
 plugin = PLUGIN_TITLE,
 version = VERSION,
 studio = STUDIO_VERSION,
 uptimeSeconds = math.floor(os.clock() - state.startedAt + 0.5),
 placeName = game.Name,
 placeId = game.PlaceId,
 gameId = game.GameId,
 }
end

function OPS.say(args)
 local text = args.text or args.message
 if type(text) ~= "string" or #text == 0 then
 error("args.text (a short message for the user) is required", 0)
 end
 abandonedTurn = nil
 addChatMessage(text)
 return { ok = true, delivered = true }
end

function OPS.turn_begin(args)
 if currentTurn ~= nil then
 error(string.format("a turn is already open (%d tools). End it first: turn end --note \"your reply\"", currentTurn.count), 0)
 end
 local turn = beginTurn()
 turn.explicit = true
 scheduleCollapse(turn)
 return { ok = true, begun = true }
end

function OPS.turn_end(args)
 local note = (type(args) == "table" and type(args.note) == "string") and args.note or nil
 if note == nil or #note == 0 then
 error('a closing note is required - end the turn with: turn end --note "your reply to the user"', 0)
 end
 if currentTurn ~= nil then
 local count = currentTurn.count
 addChatMessage(note, true, true)
 return { ok = true, ended = true, tools = count }
 end
 if abandonedTurn ~= nil then
 local count = abandonedTurn.count
 abandonedTurn = nil
 addChatMessage(note, true, true)
 return { ok = true, ended = true, tools = count, late = true }
 end
 addChatMessage(note, true, true)
 return { ok = true, ended = true, tools = 0 }
end

local function opNames()
 local names = {}
 for name in pairs(OPS) do
 table.insert(names, name)
 end
 table.sort(names)
 return names
end

local function executeCommand(cmd)
 local startedAt = os.clock()
 local opName = tostring(cmd.op)
 local handler = OPS[opName]
 local response
 if handler == nil then
 response = {
 id = cmd.id,
 ok = false,
 error = string.format("unknown op '%s'. Available ops: %s", opName, table.concat(opNames(), ", ")),
 }
 else
 local ok, result = pcall(handler, cmd.args)
 if ok then
 response = { id = cmd.id, ok = true, result = result }
 else
 response = { id = cmd.id, ok = false, error = tostring(result) }
 end
 end
 response.op = opName
 response.meta = {
 durationMs = math.floor((os.clock() - startedAt) * 1000 + 0.5),
 pluginVersion = VERSION,
 }
 return response
end

local httpNoticeShown = false
local function ensureHttpEnabled()
 local enabled = false
 local okRead = pcall(function()
 enabled = HttpService.HttpEnabled
 end)
 if okRead and enabled then
 return
 end
 local okSet = pcall(function()
 HttpService.HttpEnabled = true
 end)
 if okSet then
 if not httpNoticeShown then
 httpNoticeShown = true
 log("HttpService.HttpEnabled was off - the plugin turned it on (Game Settings -> Security).")
 end
 elseif not httpNoticeShown then
 httpNoticeShown = true
 log("WARNING: could not enable HttpService (also fails while a play session is running - it keeps retrying). Enable 'Allow HTTP Requests' in Game Settings -> Security.")
 end
end

function http(request)
 local headers = request.Headers or {}
 if headers["Content-Type"] == nil then
 headers["Content-Type"] = "application/json"
 end
 headers["X-AIBridge-Plugin"] = VERSION
 headers["X-AIBridge-Studio"] = STUDIO_VERSION
 request.Headers = headers

 request.Compress = Enum.HttpCompression.None

 local ok, response = pcall(function()
 return HttpService:RequestAsync(request)
 end)
 if not ok then
 return nil, tostring(response)
 end
 if response.Success ~= true then
 return nil, string.format("HTTP %d from %s: %s",
 response.StatusCode, request.Url, tostring(response.Body or response.StatusMessage or ""))
 end
 return response
end

local generation = 0

local function jsonSafe(s)
 if type(s) ~= "string" then
 return s
 end
 local n = #s
 local out = table.create(n)
 local i = 1
 while i <= n do
 local b = string.byte(s, i)
 if b == 10 or b == 9 then
 table.insert(out, string.sub(s, i, i))
 i = i + 1
 elseif b < 0x20 or b == 0x7F then
 if b ~= 13 then
 table.insert(out, " ")
 end
 i = i + 1
 elseif b < 0x80 then
 table.insert(out, string.sub(s, i, i))
 i = i + 1
 else

 local len = 0
 if b >= 0xF0 and b <= 0xF4 then
 len = 4
 elseif b >= 0xE0 and b <= 0xEF then
 len = 3
 elseif b >= 0xC2 and b <= 0xDF then
 len = 2
 end
 local valid = len >= 2
 if valid then
 local lo, hi = 0x80, 0xBF
 if b == 0xE0 then
 lo = 0xA0
 elseif b == 0xED then
 hi = 0x9F
 elseif b == 0xF0 then
 lo = 0x90
 elseif b == 0xF4 then
 hi = 0x8F
 end
 for j = i + 1, i + len - 1 do
 local cb = string.byte(s, j)
 local jLo = (j == i + 1) and lo or 0x80
 local jHi = (j == i + 1) and hi or 0xBF
 if cb == nil or cb < jLo or cb > jHi then
 valid = false
 break
 end
 end
 end
 if valid then
 table.insert(out, string.sub(s, i, i + len - 1))
 i = i + len
 else
 table.insert(out, "?")
 i = i + 1
 end
 end
 end
 return table.concat(out)
end

local function sanitizeEnvelope(value, depth)
 if depth > 64 then
 return tostring(value)
 end
 local kind = type(value)
 if kind == "string" then
 return jsonSafe(value)
 elseif kind == "table" then
 local out = {}
 for key, item in pairs(value) do
 if type(key) == "string" then
 local safeKey = jsonSafe(key)
 if string.sub(safeKey, 1, 1) == "$" then
 safeKey = "__" .. string.sub(safeKey, 2)
 end
 out[safeKey] = sanitizeEnvelope(item, depth + 1)
 else
 out[key] = sanitizeEnvelope(item, depth + 1)
 end
 end
 return out
 else
 return value
 end
end

local function encodeEnvelope(env)
 local body = HttpService:JSONEncode(sanitizeEnvelope(env, 0))

 if string.find(body, "\t", 1, true) then
 body = string.gsub(body, "\t", "\\t")
 end
 return body
end

local RELAY_MAX_RESULT = 900000
local RELAY_CMD_TIMEOUT = 180

local relayRng = Random.new()

local function randomHex(n)
 local chars = "0123456789abcdef"
 local out = table.create(n)
 for i = 1, n do
 local idx = relayRng:NextInteger(1, 16)
 out[i] = string.sub(chars, idx, idx)
 end
 return table.concat(out)
end

local function relayPersistLastMsgId()
 if relay.deviceId ~= nil and relay.lastMsgId ~= nil then
 pcall(function()
 plugin:SetSetting("AIBridge_LastMsg_" .. relay.deviceId, relay.lastMsgId)
 end)
 end
end

local function relayEnsureIdentity()
 if relay.deviceId ~= nil then
 return
 end
 local stored = getSetting("AIBridge_DeviceId", nil)
 relay.deviceId = randomHex(16)
 pcall(function()
 plugin:SetSetting("AIBridge_DeviceId", relay.deviceId)
 end)
 relay.lastMsgId = nil
 abandonedTurn = nil
 if type(stored) == "string" and #stored >= 8 and stored ~= relay.deviceId then
 relay._oldId = stored
 log("Session channel: " .. relay.deviceId .. " (rotated, previous channel will be wiped)")
 else
 log("Session channel: " .. relay.deviceId)
 end
end

local pendingResults = {}

local function relayPublish(env)

 if type(env.result) == "table" and not env.resultEncoded then
 local okPack, packed = pcall(function()
 return HttpService:JSONEncode(sanitizeEnvelope(env.result, 0))
 end)
 if okPack then
 env.resultEncoded = true
 env.result = packed
 end
 end
 local body = encodeEnvelope(env)
 if #body > RELAY_MAX_RESULT then
 env = {
 id = env.id,
 ok = false,
 error = string.format("result was %d bytes — too large to send from Studio (Roblox HTTP ~1MB limit). Narrow the request.", #body),
 }
 body = HttpService:JSONEncode(env)
 end

 return http({ Url = resUrl() .. ".json", Method = "POST", Body = body })
end

local function relayTrimRes()

 task.spawn(function()
 local resp = http({ Url = resUrl() .. ".json?shallow=true", Method = "GET" })
 if resp == nil then
 return
 end
 local ok, keys = pcall(function()
 return HttpService:JSONDecode(resp.Body or "")
 end)
 if not ok or type(keys) ~= "table" then
 return
 end
 local sorted = {}
 for key in pairs(keys) do
 table.insert(sorted, key)
 end
 if #sorted <= 15 then
 return
 end
 table.sort(sorted)
 for i = 1, #sorted - 15 do
 pcall(function()
 http({ Url = resUrl() .. "/" .. sorted[i] .. ".json", Method = "DELETE" })
 end)
 end
 end)
end

function OPS.debug()

 local report = {
 plugin = PLUGIN_TITLE,
 version = VERSION,
 studio = STUDIO_VERSION,
 httpEnabled = HttpService.HttpEnabled,
 uptimeSeconds = math.floor(os.clock() - state.startedAt + 0.5),
 commandsServed = state.commandsServed,
 errors = state.errors,
 }

 local marker = "debug-" .. tostring(os.clock())
 local okPost, postErr = relayPublish({ op = "debug", v = VERSION, ts = os.time(), marker = marker })
 report.relayPublish = okPost and "ok" or tostring(postErr)
 if okPost then
 local keyName = nil
 pcall(function()
 local posted = HttpService:JSONDecode(okPost.Body or "")
 if type(posted) == "table" then
 keyName = posted.name
 end
 end)
 local verified = false
 if type(keyName) == "string" then
 local resp = http({ Url = resUrl() .. "/" .. keyName .. ".json", Method = "GET" })
 if resp ~= nil and string.find(resp.Body or "", marker, 1, true) ~= nil then
 verified = true
 end
 end
 report.relayRead = verified and "ok" or "read failed"
 end
 return report
end

local function relayDeliver(env)
 local resp, err = relayPublish(env)
 if resp == nil then
 if #pendingResults < 25 then
 table.insert(pendingResults, { env = env, fails = 0 })
 end

 state.publishError = tostring(err)
 log("relay: result publish failed: " .. tostring(err))
 else
 state.publishError = nil
 relayTrimRes()
 end
 updateStatus()

 if resp ~= nil then
 local ok, data = pcall(function()
 return HttpService:JSONDecode(resp.Body or "")
 end)
 if ok and type(data) == "table" and type(data.name) == "string" then
 return data.name
 end
 end
 return nil
end

local function relayFlushPending()
 while #pendingResults > 0 do
 local pending = pendingResults[1]
 local ok, err = relayPublish(pending.env)
 if ok then
 table.remove(pendingResults, 1)
 state.publishError = nil
 elseif string.find(tostring(err), "HTTP 429", 1, true) then
 state.publishError = tostring(err) .. " (relay throttling? results queue and retry)"
 task.wait(6)
 if #pendingResults > 25 then
 table.remove(pendingResults, 1)
 end
 updateStatus()
 return
 else

 pending.fails = (pending.fails or 0) + 1
 if pending.fails >= 2 then
 if pending.env.id ~= nil and not pending.swapped then
 pending.swapped = true
 pending.fails = 0
 pending.env = {
 id = pending.env.id,
 ok = false,
 v = VERSION,
 error = string.format("the command ran, but its result could not be delivered to the relay (%s). This plugin is v%s - if this repeats, make sure Studio runs the latest Golem. Narrow the request and retry.", tostring(err), VERSION),
 }
 task.wait(1)
 else
 table.remove(pendingResults, 1)
 log("relay: dropped a result: " .. tostring(err))
 end
 else
 task.wait(1)
 end
 end
 end
 updateStatus()
end

local function relayBeaconPost(deviceId, env)
 pcall(function()
 http({
 Url = FIREBASE_DB .. "/channels/" .. tostring(deviceId) .. "/beacons.json",
 Method = "POST",
 Body = encodeEnvelope(env),
 })
 end)

 task.spawn(function()
 local resp = http({
 Url = FIREBASE_DB .. "/channels/" .. tostring(deviceId) .. "/beacons.json?shallow=true",
 Method = "GET",
 })
 if resp == nil then
 return
 end
 local okKeys, keys = pcall(function()
 return HttpService:JSONDecode(resp.Body or "")
 end)
 if not okKeys or type(keys) ~= "table" then
 return
 end
 local sorted = {}
 for key in pairs(keys) do
 table.insert(sorted, key)
 end
 if #sorted <= 5 then
 return
 end
 table.sort(sorted)
 for i = 1, #sorted - 5 do
 pcall(function()
 http({
 Url = FIREBASE_DB .. "/channels/" .. tostring(deviceId) .. "/beacons/" .. sorted[i] .. ".json",
 Method = "DELETE",
 })
 end)
 end
 end)
end

local function relayBeacon(op, extra)
 local env = { op = op, v = VERSION, ts = os.time() }
 if type(extra) == "table" then
 for key, value in pairs(extra) do
 env[key] = value
 end
 end
 relayBeaconPost(relay.deviceId, env)
end

local function relayBeaconTo(deviceId, op)

 if type(deviceId) ~= "string" or #deviceId < 8 then
 return
 end
 relayBeaconPost(deviceId, { op = op, v = VERSION, ts = os.time() })
end

local function relayHandleMessage(cmd)

 if type(cmd) ~= "table" then
 log("relay: ignored a non-JSON value on the command channel")
 return
 end
 if cmd.id == nil or type(cmd.op) ~= "string" then
 if cmd.id ~= nil then
 relayDeliver({ id = cmd.id, ok = false, error = "command must include a string 'op' and an 'id'" })
 else
 log("relay: ignored a command without an id")
 end
 return
 end
 state.commandsServed = state.commandsServed + 1
 if abandonedTurn ~= nil and cmd.op ~= "turn_end" and cmd.op ~= "say" and cmd.op ~= "ping" and cmd.op ~= "debug" then
 state.errors = state.errors + 1
 log(string.format("debt block: '%s' refused - the last turn (%d tools) still owes its closing note",
 tostring(cmd.op), abandonedTurn.count))
 relayDeliver({
 id = cmd.id,
 ok = false,
 op = tostring(cmd.op),
 error = string.format("unpaid turn note: the last turn (%d tools) was never closed with `turn end --note`. Post the missing note first: turn end --note \"summary of that work\" - then re-run your command.", abandonedTurn.count),
 turnOpen = false,
 })
 return
 end
 local chatRow = addChatCommand(cmd.op, cmd.args)

 local envelope = nil
 local finished = false
 task.spawn(function()
 if chatRow ~= nil then
 task.wait()
 end
 envelope = executeCommand(cmd)
 finished = true
 end)
 local startedAt = os.time()
 while not finished and os.time() - startedAt < RELAY_CMD_TIMEOUT do
 task.wait(0.1)
 end
 if not finished then
 envelope = {
 id = cmd.id,
 ok = false,
 error = string.format("'%s' did not finish within %d s — it may be stuck; the bridge keeps serving other commands (a Studio restart clears stuck ops)", tostring(cmd.op), RELAY_CMD_TIMEOUT),
 }
 end
 envelope = envelope or { id = cmd.id, ok = false, error = "command returned no result" }

 if type(currentTurn) == "table" and not currentTurn.collapsed then
 envelope.turnOpen = true
 envelope.turnTools = currentTurn.count
 envelope.reminder = string.format('TURN OPEN (%d tools so far). Do NOT reply yet - finish your tools, then run `npx golem-bridge turn end --note "your reply"`. `turn end` without --note is rejected.', currentTurn.count)
 else
 envelope.turnOpen = false
 end
 if chatRow ~= nil then
 chatRow.finish(envelope)
 end
 if envelope.ok then
 log(string.format("OK %s · %s ms", tostring(cmd.op), tostring(envelope.meta and envelope.meta.durationMs or "?")))
 else
 state.errors = state.errors + 1
 log(string.format("ERR %s · %s", tostring(cmd.op), tostring(envelope.error)))
 end
 local resKey = relayDeliver(envelope)
end

local function relayLoop(myGeneration)
 log(string.format("relay: live on %s (polling every ~%ds)", cmdUrl(), relay.interval))
 while myGeneration == generation do
 if not RunService:IsEdit() then

 task.wait(3)
 else
 relayFlushPending()

 local query = ".json?orderBy=" .. HttpService:UrlEncode('"$key"') .. "&limitToLast=25"
 if relay.lastMsgId ~= nil then
 query = query .. "&startAt=" .. HttpService:UrlEncode('"' .. relay.lastMsgId .. '"')
 end
 local resp, err = http({ Url = cmdUrl() .. query, Method = "GET" })
 if resp ~= nil then
 relay.okStreak = relay.okStreak + 1

 if relay.okStreak >= 12 then
 relay.interval = math.max(2, relay.interval - 1)
 relay.okStreak = 0
 end
 setConnected(true)
 if type(resp.Body) == "string" and #resp.Body > 0 and resp.Body ~= "null" then
 local okDecode, data = pcall(function()
 return HttpService:JSONDecode(resp.Body)
 end)
 if okDecode and type(data) == "table" then
 local keys = {}
 for key in pairs(data) do
 table.insert(keys, key)
 end
 table.sort(keys)
 local skippedOld = 0
 for _, key in ipairs(keys) do
 local cmd = data[key]
 if key ~= relay.lastMsgId then
 local isOld = (type(cmd) == "table" and type(cmd.ts) == "number"
 and cmd.ts < relay.skipBefore)
 if type(cmd) == "table" and not isOld then
 local okHandle, errHandle = pcall(relayHandleMessage, cmd)
 if not okHandle then
 state.errors = state.errors + 1
 log("relay: command '" .. tostring(cmd.op) .. "' crashed the handler: " .. tostring(errHandle), "err")
 if cmd.id ~= nil then
 pcall(function()
 relayDeliver({ id = cmd.id, ok = false, op = tostring(cmd.op), error = "plugin internal error, command dropped: " .. tostring(errHandle) })
 end)
 end
 end
 else
 skippedOld = skippedOld + 1
 end

 pcall(function()
 http({ Url = cmdUrl() .. "/" .. key .. ".json", Method = "DELETE" })
 end)
 end
 relay.lastMsgId = key
 end
 relayPersistLastMsgId()
 if skippedOld > 0 then
 log("relay: ignored " .. skippedOld .. " command(s) sent before this Studio session started")
 end
 end
 end
 task.wait(relay.interval)
 else
 local e = tostring(err)
 relay.okStreak = 0
 ensureHttpEnabled()
 setConnected(false, e)
 if string.find(e, "HTTP 429", 1, true) then
 relay.interval = math.min(relay.interval * 2 + 1, 25)
 log(string.format("relay: rate limited - now polling every %ds", relay.interval))
 else
 relay.interval = 2
 end
 task.wait(2.5)
 end
 end
 end
end



local function setupCommandText()

 return "Connect to my Roblox Studio, Run: npx golem-bridge connect " .. tostring(relay.deviceId)
end

local function startBridge()
 ensureHttpEnabled()
 if relay._oldId ~= nil then
 local oldId = relay._oldId
 relay._oldId = nil
 relayBeaconTo(oldId, "revoked")
 task.spawn(function()
 pcall(function()
 http({ Url = FIREBASE_DB .. "/channels/" .. tostring(oldId) .. ".json", Method = "DELETE" })
 end)
 end)
 end
 generation = generation + 1
 state.running = true
 relayEnsureIdentity()

 relay.skipBefore = os.time() - 45
 task.spawn(relayLoop, generation)
 if RunService:IsEdit() then

 relayBeacon("hello", { place = game.PlaceId })
 end
 updateStatus()
end

local function promptRefresh()
 if relay.deviceId == nil then
 return
 end
 local command = setupCommandText()
 if ui.setupBox ~= nil then
 ui.setupBox.Text = command
 end
 if ui.settingsSetupBox ~= nil then
 ui.settingsSetupBox.Text = command
 end
end

local function applyModeToUi()
 promptRefresh()
 updateStatus()
end

local function makeIcon(kind, size, color)

 local holder = createElement("Frame", {
 Name = "Icon_" .. kind,
 AnchorPoint = Vector2.new(0.5, 0.5),
 Position = UDim2.fromScale(0.5, 0.5),
 Size = UDim2.fromOffset(size, size),
 BackgroundTransparency = 1,
 })
 local function bar(w, h, x, y, rot)
 return createElement("Frame", {
 AnchorPoint = Vector2.new(0.5, 0.5),
 Position = UDim2.new(0.5, x, 0.5, y),
 Size = UDim2.fromOffset(w, h),
 BackgroundColor3 = color,
 BorderSizePixel = 0,
 Rotation = rot,
 }, holder)
 end
 if kind == "close" then
 local s = math.floor(size * 0.64)
 bar(2, s, 0, 0, 45)
 bar(2, s, 0, 0, -45)
 elseif kind == "chevronDown" then
 local s = math.floor(size * 0.52)
 local o = math.floor(s / 4)
 bar(2, s, -o, -o, 45)
 bar(2, s, o, -o, -45)
 end
 return holder
end

local function buildUi(widget, linkWidget)
 local function label(props, parent)
 local defaults = {
 BackgroundTransparency = 1,
 FontFace = fontMedium,
 TextSize = 12,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextYAlignment = Enum.TextYAlignment.Top,
 TextColor3 = COLORS.textDim,
 Text = "",
 }
 for k, v in pairs(props) do
 defaults[k] = v
 end
 return createElement("TextLabel", defaults, parent)
 end

 local function textBox(props, parent)
 local defaults = {
 BackgroundColor3 = COLORS.inner,
 TextColor3 = COLORS.text,
 PlaceholderColor3 = COLORS.textFaint,
 ClearTextOnFocus = false,
 FontFace = fontRegular,
 TextSize = 13,
 Text = "",
 BorderSizePixel = 0,
 }
 for k, v in pairs(props) do
 defaults[k] = v
 end
 local box = Instance.new("TextBox")
 for k, v in pairs(defaults) do
 if k ~= "Parent" then
 box[k] = v
 end
 end
 box.Parent = parent
 addCorner(box, 6)
 return box
 end

 local function button(props, parent, hoverColor)
 local baseColor = props.BackgroundColor3 or COLORS.neutral
 local defaults = {
 BackgroundColor3 = COLORS.neutral,
 TextColor3 = COLORS.text,
 FontFace = fontSemibold,
 TextSize = 13,
 BorderSizePixel = 0,
 AutoButtonColor = false,
 Text = "",
 }
 for k, v in pairs(props) do
 defaults[k] = v
 end
 local btn = createElement("TextButton", defaults, parent)
 addCorner(btn, 8)
 btn.MouseEnter:Connect(function()
 tween(btn, { BackgroundColor3 = hoverColor or COLORS.cardHi }, 0.12)
 end)
 btn.MouseLeave:Connect(function()
 tween(btn, { BackgroundColor3 = baseColor }, 0.2)
 end)
 return btn
 end

 ui.root = createElement("Frame", {
 Name = "Root",
 Size = UDim2.fromScale(1, 1),
 BackgroundColor3 = COLORS.bg,
 BorderSizePixel = 0,
 }, widget)

 ui.statusDot = createElement("Frame", {
 Position = UDim2.new(0, 16, 0, 19),
 Size = UDim2.fromOffset(10, 10),
 BackgroundColor3 = COLORS.textFaint,
 BorderSizePixel = 0,
 }, ui.root)
 addCorner(ui.statusDot, 5)
 ui.statusText = createElement("TextLabel", {
 Position = UDim2.new(0, 34, 0, 15),
 Size = UDim2.new(1, -150, 0, 18),
 BackgroundTransparency = 1,
 FontFace = fontMedium,
 TextSize = 13,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextTruncate = Enum.TextTruncate.AtEnd,
 TextColor3 = COLORS.textDim,
 Text = "...",
 }, ui.root)
 ui.settingsButton = button({
 AnchorPoint = Vector2.new(1, 0),
 Position = UDim2.new(1, -16, 0, 10),
 Size = UDim2.fromOffset(92, 28),
 Text = "SETTINGS",
 FontFace = fontSemibold,
 TextSize = 12,
 BackgroundColor3 = COLORS.inner,
 TextColor3 = COLORS.text,
 }, ui.root)
 createElement("Frame", {
 Name = "HeaderLine",
 Position = UDim2.new(0, 0, 0, 48),
 Size = UDim2.new(1, 0, 0, 1),
 BackgroundColor3 = COLORS.border,
 BorderSizePixel = 0,
 }, ui.root)

 ui.chatFrame = createElement("ScrollingFrame", {
 Name = "Chat",
 Position = UDim2.new(0, 16, 0, 56),
 Size = UDim2.new(1, -32, 1, -72),
 BackgroundTransparency = 1,
 BorderSizePixel = 0,
 CanvasSize = UDim2.new(0, 0, 0, 0),
 AutomaticCanvasSize = Enum.AutomaticSize.Y,
 ScrollBarThickness = 6,
 ScrollingDirection = Enum.ScrollingDirection.Y,
 }, ui.root)
 createElement("UIListLayout", {
 Padding = UDim.new(0, 6),
 SortOrder = Enum.SortOrder.LayoutOrder,
 }, ui.chatFrame)
 createElement("UIPadding", {
 PaddingTop = UDim.new(0, 2),
 PaddingBottom = UDim.new(0, 8),
 }, ui.chatFrame)

 ui.chatEmpty = createElement("TextLabel", {
 BackgroundTransparency = 1,
 AnchorPoint = Vector2.new(0.5, 0),
 Position = UDim2.new(0.5, 0, 0, 180),
 Size = UDim2.new(1, -48, 0, 60),
 FontFace = fontRegular,
 TextSize = 15,
 TextWrapped = true,
 TextColor3 = COLORS.textFaint,
 Text = "Nothing here yet.\nAsk your AI to build something — its work appears here as a clean, expandable timeline.",
 }, ui.root)

 ui.setupPopup = createElement("Frame", {
 Name = "SetupPopup",
 AnchorPoint = Vector2.new(0.5, 0.5),
 Position = UDim2.new(0.5, 0, 0.42, 0),
 Size = UDim2.new(1, -32, 0, 236),
 BackgroundColor3 = COLORS.card,
 BorderSizePixel = 0,
 Visible = false,
 }, ui.root)
 createElement("UISizeConstraint", {
 MaxSize = Vector2.new(392, 1000),
 }, ui.setupPopup)
 addCorner(ui.setupPopup, 12)
 label({
 Text = "Connect your AI",
 Position = UDim2.new(0, 16, 0, 16),
 Size = UDim2.new(1, -60, 0, 20),
 FontFace = fontSemibold,
 TextSize = 16,
 TextColor3 = COLORS.text,
 }, ui.setupPopup)
 ui.setupClose = button({
 AnchorPoint = Vector2.new(1, 0),
 Position = UDim2.new(1, -8, 0, 8),
 Size = UDim2.fromOffset(28, 28),
 Text = "",
 BackgroundColor3 = COLORS.card,
 TextColor3 = COLORS.textFaint,
 }, ui.setupPopup)
 makeIcon("close", 12, COLORS.textFaint).Parent = ui.setupClose
 label({
 Text = "Send this one line to your AI:",
 Position = UDim2.new(0, 16, 0, 48),
 Size = UDim2.new(1, -32, 0, 16),
 FontFace = fontRegular,
 TextSize = 12,
 TextColor3 = COLORS.textDim,
 }, ui.setupPopup)
 ui.setupBox = textBox({
 Position = UDim2.new(0, 16, 0, 70),
 Size = UDim2.new(1, -32, 0, 88),
 TextWrapped = true,
 MultiLine = true,
 FontFace = fontMono,
 TextSize = 13,
 TextColor3 = COLORS.text,
 BackgroundColor3 = COLORS.inner,
 }, ui.setupPopup)
 addCorner(ui.setupBox, 8)
 label({
 Text = "It runs the line, connects to this Studio session and starts working. Close any time — the same line also lives in Settings, and it changes every Studio restart.",
 Position = UDim2.new(0, 16, 0, 168),
 Size = UDim2.new(1, -32, 0, 56),
 FontFace = fontRegular,
 TextSize = 12,
 TextWrapped = true,
 TextColor3 = COLORS.textFaint,
 }, ui.setupPopup)
 ui.setupPopupToken = 0
 ui.showSetupPopup = function()
 if ui.setupPopup == nil or ui.setupPopup.Visible then
 return
 end
 ui.setupPopupToken = ui.setupPopupToken + 1
 if ui.chatEmpty ~= nil then
 ui.chatEmpty.Visible = false
 end
 ui.setupPopup.Visible = true
 ui.setupPopup.Position = UDim2.new(0.5, 0, 0.42, 10)
 tween(ui.setupPopup, { Position = UDim2.new(0.5, 0, 0.42, 0) }, 0.2)
 end
 ui.hideSetupPopup = function()
 if ui.setupPopup == nil or not ui.setupPopup.Visible then
 return
 end
 ui.setupPopupToken = ui.setupPopupToken + 1
 local myToken = ui.setupPopupToken
 tween(ui.setupPopup, { Position = UDim2.new(0.5, 0, 0.42, -8) }, 0.16)
 task.delay(0.16, function()
 if ui.setupPopup ~= nil and ui.setupPopupToken == myToken then
 ui.setupPopup.Visible = false

 if ui.chatEmpty ~= nil and #chatQueue == 0 then
 ui.chatEmpty.Visible = true
 end
 end
 end)
 end

 ui.setupPill = button({
 AnchorPoint = Vector2.new(0, 1),
 Position = UDim2.new(0, 16, 1, -16),
 Size = UDim2.fromOffset(132, 32),
 Text = "SET UP AI",
 TextSize = 12,
 BackgroundColor3 = COLORS.inner,
 TextColor3 = COLORS.text,
 Visible = false,
 }, ui.root)
 addCorner(ui.setupPill, 16)

 ui.jumpPill = button({
 AnchorPoint = Vector2.new(1, 1),
 Position = UDim2.new(1, -16, 1, -16),
 Size = UDim2.fromOffset(36, 36),
 Text = "",
 BackgroundColor3 = COLORS.card,
 TextColor3 = COLORS.text,
 Visible = false,
 ZIndex = 5,
 }, ui.root)
 addCorner(ui.jumpPill, 18)
 makeIcon("chevronDown", 16, COLORS.text).Parent = ui.jumpPill
 ui.jumpPill.Activated:Connect(function()
 smoothScrollToBottom()
 task.delay(0.25, chatUpdatePill)
 end)
 ui.chatFrame:GetPropertyChangedSignal("CanvasPosition"):Connect(chatUpdatePill)
 ui.chatFrame:GetPropertyChangedSignal("AbsoluteCanvasSize"):Connect(function()
 task.defer(chatUpdatePill)
 end)

 ui.workBanner = createElement("Frame", {
 Position = UDim2.new(0, 16, 0, 56),
 Size = UDim2.new(1, -32, 0, 30),
 BackgroundColor3 = COLORS.accent,
 BorderSizePixel = 0,
 ZIndex = 10,
 Visible = false,
 }, ui.root)
 addCorner(ui.workBanner, 8)
 ui.workDot = createElement("Frame", {
 ZIndex = 10,
 AnchorPoint = Vector2.new(0, 0.5),
 Position = UDim2.new(0, 12, 0.5, 0),
 Size = UDim2.fromOffset(10, 10),
 BackgroundColor3 = Color3.fromRGB(255, 255, 255),
 BorderSizePixel = 0,
 }, ui.workBanner)
 addCorner(ui.workDot, 5)
 ui.workText = createElement("TextLabel", {
 ZIndex = 10,
 Position = UDim2.new(0, 32, 0, 0),
 Size = UDim2.new(1, -150, 1, 0),
 BackgroundTransparency = 1,
 FontFace = fontSemibold,
 TextSize = 20,
 TextXAlignment = Enum.TextXAlignment.Left,
 TextTruncate = Enum.TextTruncate.AtEnd,
 TextColor3 = Color3.fromRGB(255, 255, 255),
 Text = "",
 }, ui.workBanner)
 ui.workCount = createElement("TextLabel", {
 ZIndex = 10,
 AnchorPoint = Vector2.new(1, 0),
 Position = UDim2.new(1, -12, 0, 0),
 Size = UDim2.new(0, 110, 1, 0),
 BackgroundTransparency = 1,
 FontFace = fontMedium,
 TextSize = 14,
 TextXAlignment = Enum.TextXAlignment.Right,
 TextColor3 = Color3.fromRGB(255, 255, 255),
 TextTransparency = 0.25,
 Text = "",
 }, ui.workBanner)

 task.spawn(function()
 while true do
 if quotesActive and ui.workBanner ~= nil and ui.workBanner.Visible
 and ui.workDot.BackgroundTransparency < 0.5 then
 tween(ui.workDot, { BackgroundTransparency = 0.55 }, 0.55)
 task.wait(0.55)
 tween(ui.workDot, { BackgroundTransparency = 0 }, 0.55)
 task.wait(0.55)
 else
 task.wait(0.25)
 end
 end
 end)

 ui.linkRoot = createElement("Frame", {
 Name = "LinkRoot",
 Size = UDim2.fromScale(1, 1),
 BackgroundColor3 = COLORS.bg,
 BorderSizePixel = 0,
 }, linkWidget)

 local settingsScroll = createElement("ScrollingFrame", {
 Size = UDim2.fromScale(1, 1),
 BackgroundTransparency = 1,
 BorderSizePixel = 0,
 CanvasSize = UDim2.new(0, 0, 0, 0),
 AutomaticCanvasSize = Enum.AutomaticSize.Y,
 ScrollBarThickness = 6,
 }, ui.linkRoot)
 local settingsList = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 0),
 AutomaticSize = Enum.AutomaticSize.Y,
 BackgroundTransparency = 1,
 }, settingsScroll)
 createElement("UIListLayout", {
 Padding = UDim.new(0, 10),
 SortOrder = Enum.SortOrder.LayoutOrder,
 }, settingsList)
 createElement("UIPadding", {
 PaddingTop = UDim.new(0, 12),
 PaddingBottom = UDim.new(0, 12),
 PaddingLeft = UDim.new(0, 12),
 PaddingRight = UDim.new(0, 12),
 }, settingsList)

 local setupCard = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 122),
 BackgroundColor3 = COLORS.card,
 BorderSizePixel = 0,
 LayoutOrder = 1,
 }, settingsList)
 addCorner(setupCard, 10)
 label({ Text = "SET UP YOUR AI", Position = UDim2.new(0, 14, 0, 10), Size = UDim2.new(1, -28, 0, 12) }, setupCard)
 label({
 Text = "Send this line to any AI — it connects to this Studio session and reads the full instructions by itself. The line changes every Studio restart:",
 Position = UDim2.new(0, 14, 0, 26),
 Size = UDim2.new(1, -28, 0, 26),
 FontFace = fontRegular,
 TextSize = 11,
 TextWrapped = true,
 TextColor3 = COLORS.textDim,
 }, setupCard)
 ui.settingsSetupBox = textBox({
 Position = UDim2.new(0, 14, 0, 56),
 Size = UDim2.new(1, -28, 0, 52),
 TextWrapped = true,
 MultiLine = true,
 FontFace = fontMono,
 TextSize = 12,
 TextColor3 = COLORS.text,
 BackgroundColor3 = COLORS.inner,
 }, setupCard)
 addCorner(ui.settingsSetupBox, 6)

 local function endSessionNow()
 if relay.deviceId ~= nil then
 relay._oldId = relay.deviceId
 end
 relay.deviceId = nil
 relay.lastMsgId = nil
 pendingResults = {}
 startBridge()
 if currentTurn ~= nil and currentTurn.count > 0 then
 abandonedTurn = { count = currentTurn.count }
 end
 chatFlushTurn()
 promptRefresh()
 log("Session ended by the user - channel rotated, new setup line issued.")
 end

 local sessionCard = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 108),
 BackgroundColor3 = COLORS.card,
 BorderSizePixel = 0,
 LayoutOrder = 2,
 }, settingsList)
 addCorner(sessionCard, 10)
 label({ Text = "SESSION", Position = UDim2.new(0, 14, 0, 10), Size = UDim2.new(1, -28, 0, 12) }, sessionCard)
 label({
 Text = "The setup line is the only key to this Studio session. If it ever leaks, end the session: the old line dies on the spot and a new one appears here.",
 Position = UDim2.new(0, 14, 0, 24),
 Size = UDim2.new(1, -28, 0, 40),
 FontFace = fontRegular,
 TextSize = 11,
 TextWrapped = true,
 TextColor3 = COLORS.textFaint,
 }, sessionCard)
 local END_SESSION_TEXT = "END SESSION AND ROTATE CHANNEL"
 ui.endSessionButton = button({
 Position = UDim2.new(0, 14, 0, 68),
 Size = UDim2.new(1, -28, 0, 28),
 Text = END_SESSION_TEXT,
 BackgroundColor3 = COLORS.inner,
 TextColor3 = COLORS.text,
 }, sessionCard, COLORS.dangerHi)
 ui.endSessionButton.Activated:Connect(function()
 if ui.endSessionButton.Text == END_SESSION_TEXT then
 ui.endSessionButton.Text = "CLICK AGAIN TO CONFIRM"
 task.delay(4, function()
 if ui.endSessionButton ~= nil and ui.endSessionButton.Text ~= END_SESSION_TEXT then
 ui.endSessionButton.Text = END_SESSION_TEXT
 end
 end)
 else
 ui.endSessionButton.Text = END_SESSION_TEXT
 endSessionNow()
 end
 end)

 local historyCard = createElement("Frame", {
 Size = UDim2.new(1, 0, 0, 92),
 BackgroundColor3 = COLORS.card,
 BorderSizePixel = 0,
 LayoutOrder = 3,
 }, settingsList)
 addCorner(historyCard, 10)
 label({ Text = "TOOL HISTORY (THIS PLACE)", Position = UDim2.new(0, 14, 0, 10), Size = UDim2.new(1, -28, 0, 12) }, historyCard)
 label({
 Text = "The chat timeline is saved per place. Older turns unload automatically — only the newest are restored on reopen.",
 Position = UDim2.new(0, 14, 0, 24),
 Size = UDim2.new(1, -28, 0, 26),
 FontFace = fontRegular,
 TextSize = 11,
 TextWrapped = true,
 TextColor3 = COLORS.textFaint,
 }, historyCard)
 local CLEAR_HISTORY_TEXT = "CLEAR TOOL HISTORY FOR THIS PLACE"
 ui.clearHistoryButton = button({
 Position = UDim2.new(0, 14, 0, 54),
 Size = UDim2.new(1, -28, 0, 28),
 Text = CLEAR_HISTORY_TEXT,
 BackgroundColor3 = COLORS.inner,
 TextColor3 = COLORS.text,
 }, historyCard, COLORS.dangerHi)

 ui.settingsButton.Activated:Connect(function()
 linkWidget.Enabled = not linkWidget.Enabled
 end)

 ui.clearHistoryButton.Activated:Connect(function()
 if ui.clearHistoryButton.Text == CLEAR_HISTORY_TEXT then
 ui.clearHistoryButton.Text = "CLICK AGAIN TO CONFIRM"
 task.delay(4, function()
 if ui.clearHistoryButton ~= nil then
 ui.clearHistoryButton.Text = CLEAR_HISTORY_TEXT
 end
 end)
 else
 ui.clearHistoryButton.Text = CLEAR_HISTORY_TEXT

 chatHistory = {}
 currentTurn = nil
 for _, holder in ipairs(chatQueue) do
 pcall(function()
 holder:Destroy()
 end)
 end
 chatQueue = {}
 chatOrder = 0
 pcall(function()
 plugin:SetSetting(chatPlaceKey(), "")
 end)
 if ui.chatEmpty ~= nil then
 ui.chatEmpty.Visible = true
 end
 if refreshWorking ~= nil then
 refreshWorking()
 end
 chatScroll()
 log("Tool history cleared for this place.")
 end
 end)

 ui.setupPill.Activated:Connect(function()
 if ui.showSetupPopup ~= nil then
 ui.showSetupPopup()
 end
 end)
 ui.setupClose.Activated:Connect(function()
 if ui.hideSetupPopup ~= nil then
 ui.hideSetupPopup()
 end
 end)
end

local toolbar = plugin:CreateToolbar("Golem")
local toolbarButton = toolbar:CreateButton("Golem", "Your AI builder — connects an AI agent to this Studio session", "")
toolbarButton.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui("GolemWidget", DockWidgetPluginGuiInfo.new(
 Enum.InitialDockState.Float,
 false,
 false,
 560, 760,
 480, 360
))
widget.Title = PLUGIN_TITLE .. " v" .. VERSION

local linkWidget = plugin:CreateDockWidgetPluginGui("GolemSettingsWidget", DockWidgetPluginGuiInfo.new(
 Enum.InitialDockState.Float,
 false,
 false,
 600, 700,
 520, 560
))
linkWidget.Title = "Golem — Settings"

toolbarButton.Click:Connect(function()
 widget.Enabled = not widget.Enabled
end)

relayEnsureIdentity()

local okUi, uiErr = pcall(buildUi, widget, linkWidget)
if not okUi then
 warn("[Golem] widget failed to build: " .. tostring(uiErr) .. " (the bridge still runs - please report this)")
end
pcall(chatRestore)
pcall(applyModeToUi)

plugin.Unloading:Connect(function()
 generation = generation + 1
 state.running = false
 pcall(chatPersistNow)
end)

log("Golem v" .. VERSION .. " loaded.")

if ui.setupPill ~= nil and ui.chatEmpty ~= nil then
 ui.setupPill.Visible = ui.chatEmpty.Visible and #chatQueue == 0
end
if ui.showSetupPopup ~= nil then
 ui.showSetupPopup()
end

startBridge()