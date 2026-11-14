-- Minimal but real Roblox shim: enough to boot the plugin's window and drive its
-- controls. Objects are tables with a class, children, and a signal table.
local events = {}
local function signal()
  local s = { handlers = {} }
  function s:Connect(fn)
    self.handlers[#self.handlers + 1] = fn
    return { Disconnect = function() end }
  end
  function s:Fire(...)
    for _, fn in ipairs(self.handlers) do
      local ok, err = pcall(fn, ...)
      if not ok then _G.__uiErrors[#_G.__uiErrors + 1] = tostring(err) end
    end
  end
  return s
end
_G.__newSignal = signal
_G.__uiErrors = {}

local Vector2 = { new = function(x, y) return { X = x or 0, Y = y or 0, __vec2 = true } end }
_G.Vector2 = Vector2
-- Vector3 with the arithmetic the plugin really uses (+, -, *, /, Magnitude, Unit)
local V3 = {}
V3.__index = function(t, k)
  if k == "Magnitude" then return math.sqrt(t.X * t.X + t.Y * t.Y + t.Z * t.Z) end
  if k == "Unit" then
    local m = math.sqrt(t.X * t.X + t.Y * t.Y + t.Z * t.Z)
    if m == 0 then return V3.new(0, 0, 0) end
    return V3.new(t.X / m, t.Y / m, t.Z / m)
  end
  return nil
end
V3.__add = function(a, b) return V3.new(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
V3.__sub = function(a, b) return V3.new(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
V3.__unm = function(a) return V3.new(-a.X, -a.Y, -a.Z) end
V3.__mul = function(a, b)
  if type(a) == "number" then return V3.new(a * b.X, a * b.Y, a * b.Z) end
  if type(b) == "number" then return V3.new(a.X * b, a.Y * b, a.Z * b) end
  return V3.new(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
end
V3.__div = function(a, b)
  if type(b) == "number" then return V3.new(a.X / b, a.Y / b, a.Z / b) end
  return V3.new(a.X / b.X, a.Y / b.Y, a.Z / b.Z)
end
V3.__eq = function(a, b) return a.X == b.X and a.Y == b.Y and a.Z == b.Z end
V3.__tostring = function(a) return string.format("%g, %g, %g", a.X, a.Y, a.Z) end
function V3.dot(a, b) return a.X * b.X + a.Y * b.Y + a.Z * b.Z end
function V3.cross(a, b)
  return V3.new(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X)
end
function V3.new(x, y, z)
  return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, V3)
end
V3.zero = V3.new(0, 0, 0)
V3.one = V3.new(1, 1, 1)
_G.Vector3 = setmetatable({}, { __index = V3, __call = function(_, x, y, z) return V3.new(x, y, z) end })

-- CFrame: stores a position and an orientation matrix (rows), so composition,
-- inverse and PointToWorldSpace behave as they do in Studio.
local CF = {}
local function cfNew(pos, rot)
  return setmetatable({ Position = pos, _rot = rot or { { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 } } }, CF)
end
local function matMul(a, b)
  local out = {}
  for i = 1, 3 do
    out[i] = {}
    for j = 1, 3 do
      local sum = 0
      for k = 1, 3 do sum = sum + a[i][k] * b[k][j] end
      out[i][j] = sum
    end
  end
  return out
end
local function euler(x, y, z)
  local cx, sx = math.cos(x), math.sin(x)
  local cy, sy = math.cos(y), math.sin(y)
  local cz, sz = math.cos(z), math.sin(z)
  local rx = { { 1, 0, 0 }, { 0, cx, -sx }, { 0, sx, cx } }
  local ry = { { cy, 0, sy }, { 0, 1, 0 }, { -sy, 0, cy } }
  local rz = { { cz, -sz, 0 }, { sz, cz, 0 }, { 0, 0, 1 } }
  return matMul(matMul(rx, ry), rz)
end
CF.__index = function(t, k)
  if k == "Rotation" then return cfNew(V3.new(0, 0, 0), t._rot) end
  if k == "LookVector" then return V3.new(-t._rot[1][3], -t._rot[2][3], -t._rot[3][3]) end
  if k == "RightVector" then return V3.new(t._rot[1][1], t._rot[2][1], t._rot[3][1]) end
  if k == "UpVector" then return V3.new(t._rot[1][2], t._rot[2][2], t._rot[3][2]) end
  if k == "X" then return t.Position.X end
  if k == "Y" then return t.Position.Y end
  if k == "Z" then return t.Position.Z end
  return CF[k]
end
CF.__mul = function(a, b)
  if getmetatable(b) == V3 then
    local r = a._rot
    return V3.new(
      r[1][1] * b.X + r[1][2] * b.Y + r[1][3] * b.Z + a.Position.X,
      r[2][1] * b.X + r[2][2] * b.Y + r[2][3] * b.Z + a.Position.Y,
      r[3][1] * b.X + r[3][2] * b.Y + r[3][3] * b.Z + a.Position.Z)
  end
  -- rotate b's offset into a's frame, then translate
  local r = a._rot
  local off = V3.new(
    r[1][1] * b.Position.X + r[1][2] * b.Position.Y + r[1][3] * b.Position.Z,
    r[2][1] * b.Position.X + r[2][2] * b.Position.Y + r[2][3] * b.Position.Z,
    r[3][1] * b.Position.X + r[3][2] * b.Position.Y + r[3][3] * b.Position.Z)
  return cfNew(a.Position + off, matMul(r, b._rot))
end
CF.__add = function(a, b) return cfNew(a.Position + b) end
CF.__sub = function(a, b) return cfNew(a.Position - b) end
CF.__tostring = function(a) return "CFrame(" .. tostring(a.Position) .. ")" end
CF.fromOrientation = function(x, y, z) return cfNew(V3.new(0, 0, 0), euler(x, y, z)) end
CF.Angles = function(x, y, z) return cfNew(V3.new(0, 0, 0), euler(x, y, z)) end
CF.fromEulerAnglesXYZ = CF.Angles
CF.fromAxisAngle = function(axis, angle)
  local u = axis.Unit
  local c, s2 = math.cos(angle), math.sin(angle)
  local ico = 1 - c
  return cfNew(V3.new(0, 0, 0), {
    { c + u.X * u.X * ico, u.X * u.Y * ico - u.Z * s2, u.X * u.Z * ico + u.Y * s2 },
    { u.Y * u.X * ico + u.Z * s2, c + u.Y * u.Y * ico, u.Y * u.Z * ico - u.X * s2 },
    { u.Z * u.X * ico - u.Y * s2, u.Z * u.Y * ico + u.X * s2, c + u.Z * u.Z * ico },
  })
end
CF.lookAt = function(from, to, up)
  local dir = (to - from).Unit
  local right = V3.cross(dir, up or V3.new(0, 1, 0)).Unit
  local realUp = V3.cross(right, dir)
  return cfNew(from, {
    { right.X, realUp.X, -dir.X },
    { right.Y, realUp.Y, -dir.Y },
    { right.Z, realUp.Z, -dir.Z },
  })
end
CF.new = function(x, y, z)
  if type(x) == "table" and x ~= nil and getmetatable(x) == V3 then return cfNew(x) end
  return cfNew(V3.new(x or 0, y or 0, z or 0))
end
_G.CFrame = CF

_G.UDim = { new = function(a, b) return { Scale = a or 0, Offset = b or 0 } end }
_G.UDim2 = {
  new = function(a, b, c, d)
    return { X = { Scale = a or 0, Offset = b or 0 }, Y = { Scale = c or 0, Offset = d or 0 } }
  end,
  fromOffset = function(x, y) return _G.UDim2.new(0, x or 0, 0, y or 0) end,
  fromScale = function(x, y) return _G.UDim2.new(x or 0, 0, y or 0, 0) end,
}
_G.Color3 = {
  new = function(r, g, b) return { R = r or 0, G = g or 0, B = b or 0 } end,
  fromRGB = function(r, g, b) return { R = (r or 0) / 255, G = (g or 0) / 255, B = (b or 0) / 255 } end,
}
_G.NumberSequence = { new = function() return {} end }
_G.NumberRange = { new = function(a, b) return { Min = a or 0, Max = b or a or 0 } end }
_G.NumberSequenceKeypoint = { new = function(t, v) return { Time = t, Value = v } end }
_G.Rect = { new = function() return {} end }
_G.Font = { new = function() return {} end, fromEnum = function() return {} end }
_G.TweenInfo = { new = function(t) return { Time = t or 0 } end }
_G.tween = function(inst, props, time)
  for k, v in pairs(props or {}) do
    inst[k] = v
  end
  return { Cancel = function() end, Completed = { Wait = function() end } }
end
_G.TweenService = { Create = function() return { Play = function() end, Cancel = function() end } end }

local passThrough = { Name = true, Text = true, Source = true, Visible = true,
  Enabled = true, Disabled = true, Title = true, RunContext = true, PlaceholderText = true,
  PlaceholderColor3 = true, TextColor3 = true, BackgroundColor3 = true,
  BackgroundTransparency = true, TextTransparency = true, TextSize = true,
  TextWrapped = true, TextEditable = true, ClearTextOnFocus = true, MultiLine = true,
  FontFace = true, TextXAlignment = true, TextYAlignment = true, TextTruncate = true,
  ZIndex = true, LayoutOrder = true, BorderSizePixel = true, Rotation = true,
  RichText = true, CursorPosition = true, CornerRadius = true, Padding = true,
  PaddingTop = true, PaddingBottom = true, PaddingLeft = true, PaddingRight = true,
  MaxSize = true, SizeConstraint = true, AutomaticSize = true, ClipsDescendants = true,
  Selectable = true, AnchorPoint = true, Position = true, Size = true, Parent = true,
  UiPadding = true, Active = true, Visible2 = true, SelectionOrder = true,
  CanvasPosition = true, CanvasSize = true, ScrollBarThickness = true,
  ScrollingDirection = true, ScrollBarImageTransparency = true,
}
local known = {
  FillDirection = { Horizontal = 1 }, HorizontalAlignment = { Left = 1 },
  VerticalAlignment = { Top = 1 }, SortOrder = { LayoutOrder = 1, Name = 2 },
  TextXAlignment = { Left = 1, Center = 2, Right = 3 },
  TextYAlignment = { Top = 1, Center = 2, Bottom = 3 },
  TextTruncate = { AtEnd = 1, None = 2 },
}
local function knownValue(key, value)
  if type(value) == "table" and not value.__inst and known[key] ~= nil then
    return value
  end
  return value
end

local function makeInstance(class, name)
  local props = { Visible = true, CursorPosition = -1, SelectionStart = -1, SelectionEnd = -1 }
  if class == "Part" or class == "MeshPart" then
    props.Size = Vector3.new(4, 1, 2)
    props.Position = Vector3.new(0, 0, 0)
    props.CFrame = CFrame.new(0, 0, 0)
  end
  if class == "Camera" then
    props.CFrame = CFrame.new(0, 10, 20)
    props.FieldOfView = 70
  end
  if class == "ScrollingFrame" then
    props.CanvasPosition = Vector2.new(0, 0)
    props.CanvasSize = Vector2.new(0, 0)
  end
  local obj = { ClassName = class, Name = name or class, _children = {}, _signals = {}, _props = props }
  function obj:_sig(key) self._signals[key] = self._signals[key] or signal() return self._signals[key] end
  function obj:GetChildren() return self._children end
  function obj:FindFirstChild(want)
    for _, c in ipairs(self._children) do if c.Name == want then return c end end
    return nil
  end
  function obj:GetDescendants()
    local out = {}
    for _, c in ipairs(self._children) do
      out[#out + 1] = c
      for _, d in ipairs(c:GetDescendants()) do out[#out + 1] = d end
    end
    return out
  end
  function obj:Destroy()
    local p = obj.Parent
    if p ~= nil then
      for i, c in ipairs(p._children) do if c == obj then table.remove(p._children, i) break end end
    end
    obj.Parent = nil
  end
  function obj:CaptureFocus()
    self._props.focused = true
    self:_sig("Focused"):Fire()
    self._props.CursorPosition = #tostring(self._props.Text or "") + 1
    self._props.SelectionStart = -1
    self._props.SelectionEnd = -1
    _G.__focusedTextBox = self
  end
  function obj:ReleaseFocus()
    self._props.focused = false
    -- not being edited: Studio reports -1 for the caret and the selection
    self._props.CursorPosition = -1
    self._props.SelectionStart = -1
    self._props.SelectionEnd = -1
    if _G.__focusedTextBox == self then _G.__focusedTextBox = nil end
  end
  function obj:IsFocused() return self._props.focused == true end
  function obj:GetPropertyChangedSignal(key) return self:_sig("prop:" .. key) end
  function obj:GetChildren() return self._children end
  function obj:FindFirstChild(name)
    for _, c in ipairs(self._children) do if c.Name == name then return c end end
    return nil
  end
  function obj:FindFirstChildOfClass(class)
    for _, c in ipairs(self._children) do if c.ClassName == class then return c end end
    return nil
  end
  function obj:WaitForChild(name) return obj:FindFirstChild(name) end
  function obj:GetAttribute(key) return (self._props._attributes or {})[key] end
  function obj:SetAttribute(key, value)
    self._props._attributes = self._props._attributes or {}
    self._props._attributes[key] = value
  end
  function obj:GetAttributes() return self._props._attributes or {} end
  _G.__tags = _G.__tags or {}
  function obj:GetTags()
    local out = {}
    for tag, set in pairs(_G.__tags) do if set[self] then out[#out + 1] = tag end end
    return out
  end
  function obj:HasTag(tag) return _G.__tags[tag] ~= nil and _G.__tags[tag][self] == true end
  function obj:AddTag(tag)
    _G.__tags[tag] = _G.__tags[tag] or {}
    _G.__tags[tag][self] = true
  end
  function obj:RemoveTag(tag) if _G.__tags[tag] then _G.__tags[tag][self] = nil end end
  function obj:IsA(want)
    if self.ClassName == want then return true end
    local parents = {
      Part = { "BasePart", "PVInstance", "Instance" },
      MeshPart = { "BasePart", "PVInstance", "Instance" },
      Model = { "PVInstance", "Instance" },
      Script = { "LuaSourceContainer", "Instance" },
      ModuleScript = { "LuaSourceContainer", "Instance" },
      LocalScript = { "LuaSourceContainer", "Instance" },
      Folder = { "Instance" }, Frame = { "GuiObject", "Instance" },
      TextLabel = { "GuiObject", "Instance" }, TextButton = { "GuiObject", "Instance" },
      TextBox = { "GuiObject", "Instance" }, ImageLabel = { "GuiObject", "Instance" },
      ScrollingFrame = { "GuiObject", "Instance" }, ScreenGui = { "LayerCollector", "Instance" },
      PointLight = { "Light", "Instance" }, ParticleEmitter = { "Instance" },
      ProximityPrompt = { "Instance" }, Trail = { "Instance" }, Beam = { "Instance" },
      Sound = { "Instance" }, Terrain = { "BasePart", "Instance" },
    }
    for _, c in ipairs(parents[self.ClassName] or {}) do
      if c == want then return true end
    end
    return false
  end
  function obj:Clone() return makeInstance(class, name) end
  function obj:GetFullName() return obj.Name end
  function obj:GetPivot()
    local props = rawget(self, "_props")
    return props.CFrame or CFrame.new(props.Position or Vector3.new(0, 0, 0))
  end
  function obj:PivotTo(cf) if cf ~= nil then rawget(self, "_props").CFrame = cf end end
  function obj:GetPivotPosition() return self:GetPivot().Position end

  return setmetatable(obj, {
    __index = function(self, key)
      if key == "Activated" or key == "MouseButton1Click" or key == "Began" or key == "Changed"
        or key == "MouseEnter" or key == "MouseLeave" or key == "MouseButton1Down"
        or key == "MouseButton1Up" or key == "InputBegan" or key == "InputChanged" then
        return self:_sig(key)
      end
      if key == "FocusLost" then return self:_sig("FocusLost") end
      if key == "Focused" then return self:_sig("Focused") end
      if key == "Parent" then return rawget(self, "_props").Parent end
      if (key == "CursorPosition" or key == "SelectionStart" or key == "SelectionEnd")
        and rawget(self, "_props").focused ~= true then
        -- documented TextBox behaviour: these are -1 while the box is not
        -- being edited, so an unfocused box can never hold a selection
        return -1
      end
      if key == "WorldPivot" then
        local p = rawget(self, "_props")
        return p.CFrame or _G.CFrame.new(p.Position or _G.Vector3.new(0, 0, 0))
      end
      if key == "AbsoluteSize" or key == "AbsolutePosition" or key == "AbsoluteCanvasSize"
        or key == "AbsoluteWindowSize" then return Vector2.new(400, 300) end
      if passThrough[key] or known[key] then return rawget(self, "_props")[key] end
      -- anything the object already stores is a real property (Size, CFrame...)
      local stored = rawget(self, "_props")[key]
      if stored ~= nil then return stored end
      if key == "Text" or key == "Visible" then return rawget(self, "_props")[key] end
      if _G.__strictUI == true and string.sub(key, 1, 1) ~= "_" then
        error(string.format("unknown UI property %s.%s", tostring(self.ClassName), tostring(key)), 2)
      end
      return nil
    end,
    __newindex = function(self, key, value)
      if key == "Parent" then
        -- keep Parent out of the raw table, or the second assignment would
        -- bypass __newindex and silently drop the child from its new parent
        local props = rawget(self, "_props")
        local old = props.Parent
        if old ~= nil and type(old) == "table" and old._children ~= nil then
          for i, c in ipairs(old._children) do
            if c == self then table.remove(old._children, i) break end
          end
        end
        props.Parent = value
        if value ~= nil and value._children ~= nil then
          value._children[#value._children + 1] = self
        end
        return
      end
      if key == "WorldPivot" then rawget(self, "_props").CFrame = value return end
      if (key == "CursorPosition" or key == "SelectionStart" or key == "SelectionEnd")
        and rawget(self, "_props").focused ~= true then
        rawget(self, "_props")[key] = -1
        return
      end
      rawget(self, "_props")[key] = knownValue(key, value)
      rawset(self, key, value)
    end,
  })
end

_G.Instance = { new = function(class) return makeInstance(class) end }
_G.DockWidgetPluginGuiInfo = { new = function() return {} end }
_G.Enum = setmetatable({
  InitialDockState = { Float = 1 },
  FontWeight = { Regular = 1, Medium = 2, SemiBold = 3, Bold = 4 },
  TextXAlignment = { Left = 1, Center = 2, Right = 3 },
  TextYAlignment = { Top = 1, Center = 2, Bottom = 3 },
  TextTruncate = { AtEnd = 1, None = 2 },
  SortOrder = { LayoutOrder = 1, Name = 2 },
  FillDirection = { Horizontal = 1, Vertical = 2 },
  HorizontalAlignment = { Left = 1, Center = 2, Right = 3 },
  VerticalAlignment = { Top = 1, Center = 2, Bottom = 3 },
  RunContext = { Server = 1, Client = 2, Legacy = 3 },
  UserInputType = { MouseButton1 = 1 },
  MessageType = { MessageError = 1, MessageWarning = 2, MessageOutput = 3 },
  PlaybackState = { Completed = 1, Cancelled = 2 },
  -- real Enum items stringify as "Enum.KeyCode.C", and that is how plugin code
  -- and this shim compare them
  KeyCode = setmetatable({}, { __index = function(_, k)
    return setmetatable({ Name = k }, {
      __tostring = function() return "Enum.KeyCode." .. k end,
      __eq = function(a, b) return type(b) == "table" and a.Name == b.Name end,
    })
  end }),
  ZIndexBehavior = { Global = 1, Sibling = 2 },
  AutomaticSize = { None = 1, X = 2, Y = 3, XY = 4 },
}, { __index = function(_, k) return setmetatable({}, { __index = function(_, kk) return { Name = kk } end }) end })

_G.game = makeInstance("DataModel", "game")
-- services the plugin looks up by name but which have no object semantics
local serviceImpl = {
  TweenService = {
    Create = function() return { Play = function() end, Cancel = function() end } end,
  },
  CaptureService = { CaptureScreenshot = function(self, cb) cb("rbxtemp://shot") end },
  ScriptEditorService = {},
  Selection = { Get = function() return {} end, Set = function() end },
  AssetService = {},
}
_G.game.PlaceId = 1234
local services = {}
function _G.game:GetService(want)
  if services[want] == nil then
    services[want] = serviceImpl[want] or makeInstance(want, want)
  end
  return services[want]
end
function _G.game:FindService(want) return services[want] end
function _G.game:GetChildren() return {} end
_G.__services = services
_G.workspace = _G.game:GetService("Workspace")
_G.workspace.CurrentCamera = makeInstance("Camera", "Camera")
_G.workspace.Terrain = makeInstance("Terrain", "Terrain")

local http = _G.game:GetService("HttpService")
http.HttpEnabled = true
function http:RequestAsync(req)
  if _G.__httpReply then
    return { Success = true, StatusCode = 200, Body = _G.__httpReply(req) }
  end
  return { Success = true, StatusCode = 200, Body = "null" }
end
function http:JSONEncode(v) return _G.__jsonEncode(v) end
function http:JSONDecode(s) return _G.__jsonDecode(s) end
function http:UrlEncode(s) return s end
function http:GenerateGUID() return "guid" end

local run = _G.game:GetService("RunService")
run._running = false
function run:IsRunning() return self._running end
function run:IsEdit() return not self._running end
function run:IsRunMode() return self._running end
run.Heartbeat = signal()
run.RenderStepped = signal()

local ch = _G.game:GetService("ChangeHistoryService")
function ch:TryBeginRecording() return "rec" end
function ch:FinishRecording() end
function ch:SetWaypoint() end
function ch:GetRecordingState() return nil end
ch._undo, ch._redo = {}, {}
function ch:GetCanUndo() return #ch._undo > 0 end
function ch:GetCanRedo() return #ch._redo > 0 end
function ch:Undo()
  if #ch._undo == 0 then return end
  local e = table.remove(ch._undo)
  ch._redo[#ch._redo + 1] = e
  e.what = "undo"
end
function ch:Redo()
  if #ch._redo == 0 then return end
  local e = table.remove(ch._redo)
  ch._undo[#ch._undo + 1] = e
  e.what = "redo"
end

-- Roblox has NO clipboard-write API for plugins. The API dump has exactly one
-- clipboard member (StudioService:CopyToClipboard, RobloxScriptSecurity), and
-- `setclipboard` is an exploit-executor global that Studio does not define.
-- This shim deliberately does not define it either: the previous version did,
-- which is why a copy button that copied nothing passed the test suite.
--
-- The only path left is the one a person uses - select the text, send Ctrl+C -
-- so the shim models UserInputService:CreateVirtualInput and applies the
-- keystroke to the focused TextBox's selection, like the real thing would.
local function applyCopyKey(code)
  local box = _G.__focusedTextBox
  if box == nil or _G.__virtualKeyDown ~= true then return end
  if tostring(code) ~= "Enum.KeyCode.C" then return end
  local text = tostring(box.Text or "")
  -- Per the TextBox docs: CursorPosition and SelectionStart are 1-based
  -- ("a value of 1 represents the position before the first byte") and -1
  -- means the box is not being edited / has no selection. The selection spans
  -- from min to max-1; an earlier version treated these as 0-based, which
  -- copied the line missing its first character.
  local cursor = tonumber(box.CursorPosition or -1) or -1
  local start = tonumber(box.SelectionStart or -1) or -1
  if cursor < 0 or start < 0 then
    _G.__clipboard = nil
    return
  end
  local from = math.min(cursor, start)
  local to = math.max(cursor, start) - 1
  if to < from then
    _G.__clipboard = ""
    return
  end
  _G.__clipboard = string.sub(text, from, to)
end
function _G.warn(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
  _G.__warnings = _G.__warnings or {}
  _G.__warnings[#_G.__warnings + 1] = table.concat(parts, " ")
end
local logS = _G.game:GetService("LogService")
function logS:GetLogHistory() return {} end
MessageOut = nil
local terr = _G.game:GetService("Workspace").Terrain
terr = terr or makeInstance("Terrain", "Terrain")
function terr:FillBlock() end
function terr:FillBall() end
function terr:Clear() end
function terr:ReadVoxels() return nil, Vector3.new(1, 1, 1) end
function terr:WriteVoxels() end
-- UserInputService:CreateVirtualInput is the only input-synthesis API with
-- no security level, i.e. the only one a plugin may call. VirtualInputManager
-- and GuiService:AddKey are RobloxScriptSecurity and stay absent here.
local uis = _G.game:GetService("UserInputService")
-- VirtualInput, exactly as the API dump describes it. Its only key function is
-- SendKey(isPressed: bool, keyCode: KeyCode, isRepeated: bool); there is no
-- SendKeyDown/SendKeyUp. An earlier shim invented those, so the plugin called
-- functions that do not exist, the pcall swallowed it, and copy silently sent
-- no input at all.
function uis:CreateVirtualInput()
  local v = {}
  function v:SendKey(isPressed, keyCode, isRepeated)
    assert(type(isPressed) == "boolean", "SendKey: isPressed must be a boolean")
    assert(keyCode ~= nil, "SendKey: keyCode is required")
    _G.__virtualKeysSent = (_G.__virtualKeysSent or 0) + 1
    local name = tostring(keyCode)
    if name == "Enum.KeyCode.LeftControl" then
      _G.__virtualKeyDown = isPressed == true
      return
    end
    if name == "Enum.KeyCode.C" then
      if isPressed == true then
        _G.__virtualLetters = (_G.__virtualLetters or 0) + 1
        if _G.__virtualKeyDown == true then
          applyCopyKey(keyCode)
        end
      end
      return
    end
  end
  function v:SendTextInput(text)
    _G.__virtualText = tostring(text)
  end
  function v:SendMouseButton() end
  function v:SendMouseDelta() end
  function v:SendMousePosition() end
  function v:SendPointerAction() end
  return v
end

_G.version = function() return "ShimStudio/1.0" end
_G.typeof = function(v)
  if v ~= nil and type(v) == "table" and v.__inst then return "Instance" end
  return type(v)
end
_G.tick = function() return os.clock() end
_G.loadstring = function(code) local f, err = load(code) return f, err end

-- task scheduler: cooperative, driven by step()
local now, threads = 0, {}
_G.__threads = threads
local function addThread(co, at) threads[#threads + 1] = { co = co, at = at } end
_G.__newThread = function(fn, ...)
  if fn == nil then error("__newThread was given no function", 2) end
  local args = { ... }
  addThread(coroutine.create(function() fn(table.unpack(args)) end), now)
end
_G.__addThread = addThread
_G.task = {
  wait = function(t) coroutine.yield(t or 0) end,
  spawn = function(fn, ...) _G.__newThread(fn, ...) end,
  defer = function(fn, ...) _G.__newThread(fn, ...) end,
  delay = function(t, fn, ...)
    local args = { ... }
    addThread(coroutine.create(function() fn(table.unpack(args)) end), now + (t or 0))
  end,
}
_G.wait = function(t) _G.task.wait(t) end
_G.spawn = function(fn, ...) _G.task.spawn(fn, ...) end
_G.delay = function(t, fn, ...) _G.task.delay(t, fn, ...) end
_G.__advance = function(seconds)
  local target = now + seconds
  local guard = 0
  while true do
    guard = guard + 1
    if guard > 200000 then error("scheduler made no progress") end
    local pick, idx = nil, nil
    for i, th in ipairs(threads) do
      if th.at <= target and (pick == nil or th.at < pick.at) then pick, idx = th, i end
    end
    if pick == nil then now = target return end
    if pick.at > now then now = pick.at end
    local ok, waitFor = coroutine.resume(pick.co)
    if not ok then
      _G.__uiErrors[#_G.__uiErrors + 1] = tostring(waitFor)
      table.remove(threads, idx)
    elseif coroutine.status(pick.co) == "dead" then
      table.remove(threads, idx)
    else
      pick.at = now + (tonumber(waitFor) or 0)
    end
  end
end

_G.plugin = {
  _settings = {},
  GetSetting = function(self, key) return self._settings[key] end,
  SetSetting = function(self, key, value) self._settings[key] = value end,
  CreateToolbar = function()
    return { CreateButton = function()
      return { Click = signal(), ClickableWhenViewportHidden = false }
    end }
  end,
  CreateDockWidgetPluginGui = function(self, id)
    local w = makeInstance("DockWidgetPluginGui", id)
    _G.__widgets = _G.__widgets or {}
    _G.__widgets[#_G.__widgets + 1] = w
    return w
  end,
  Unloading = signal(),
  MultipleDocumentSelectionChanged = signal(),
  GetStudioUserId = function() return 1 end,
  CreatePluginAction = function()
    return { Triggered = signal(), ActionId = "act" }
  end,
}

-- Random is used to mint the 16-hex channel id
_G.Random = { new = function()
  -- real Random.new() seeds from entropy; a fixed seed would make channel
  -- rotation invisible to tests
  _G.__randomSeed = (_G.__randomSeed or 0) + 1
  local r = { _seed = (os.time() * 7919 + _G.__randomSeed * 104729) % 65536 }
  function r:NextInteger(lo, hi)
    -- keep every intermediate under 2^53 so double arithmetic stays exact
    self._seed = (self._seed * 25173 + 13849) % 65536
    local span = (hi - lo) + 1
    return lo + (self._seed % span)
  end
  function r:NextNumber(a, b)
    a, b = a or 0, b or 1
    self._seed = (self._seed * 25173 + 13849) % 65536
    return a + (b - a) * (self._seed / 65536)
  end
  return r
end }

table.create = table.create or function(n, value)
  local t = {}
  for i = 1, (n or 0) do t[i] = value end
  return t
end
table.pack = table.pack or function(...) return { n = select("#", ...), ... } end
table.unpack = table.unpack or unpack
math.clamp = function(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end
task.cancel = function() end
task.delay = task.delay

-- Sequences and RichText helpers the effects ops rely on. Defined at the very
-- end so nothing later in this file can replace them.
_G.ColorSequence = { new = function(a, b)
  return { Keypoints = { a or { Time = 0 }, b or { Time = 1 } } }
end }
_G.ColorSequenceKeypoint = { new = function(t, c) return { Time = t or 0, Value = c } end }
_G.NumberSequence = { new = function(a, b)
  return { Keypoints = { a or { Time = 0 }, b or { Time = 1 } } }
end }
_G.NumberSequenceKeypoint = { new = function(t, v) return { Time = t or 0, Value = v or 0 } end }
_G.NumberRange = { new = function(a, b) return { Min = a or 0, Max = b or a or 0 } end }
