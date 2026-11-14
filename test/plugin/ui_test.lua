-- Drives the panel controls a user actually touched. Every assertion here maps to
-- a complaint: popup cannot close, a dead button, copy stealing focus, and an
-- editable line.
local M = {}

local function find(root, predicate, acc)
  acc = acc or {}
  for _, c in ipairs(root:GetChildren()) do
    if predicate(c) then acc[#acc + 1] = c end
    find(c, predicate, acc)
  end
  return acc
end

local function textOf(root)
  local out = {}
  for _, c in ipairs(find(root, function(n)
    return n.ClassName == "TextLabel" or n.ClassName == "TextButton" or n.ClassName == "TextBox"
  end)) do
    out[#out + 1] = tostring(c.Text or "")
  end
  return table.concat(out, "\n")
end

local function assertTrue(cond, msg)
  if not cond then error("UI TEST FAILED: " .. msg, 0) end
end

function M.run()
  __chunk_shim()
  _G.__jsonEncode = __chunk_json().encode
  _G.__jsonDecode = __chunk_json().decode
  _G.__newThread(__chunk_plugin)
  _G.__advance(3)

  local widgets = _G.__widgets or {}
  assertTrue(#widgets >= 1, "no widget was created")
  local panel = widgets[1]
  local settings = widgets[2]

  -- the setup popup opens on a first run, which is the state the user was in
  -- The popup is the SMALLEST frame that DIRECTLY contains the copy button.
  -- Taking "the first frame with it somewhere inside" matches the root window,
  -- which is exactly how a test ends up asserting nothing about the popup.
  local popup
  for _, f in ipairs(find(panel, function(n) return n.ClassName == "Frame" end)) do
    for _, c in ipairs(f:GetChildren()) do
      if tostring(c.Text) == "COPY THE LINE" then popup = f break end
    end
    if popup ~= nil then break end
  end
  if popup == nil then


  end
  assertTrue(popup ~= nil, "the setup popup never opened")
  assertTrue(popup.Visible == true or popup.Visible == nil, "the popup did not open visibly")

  -- 1. it must be closable: there is a close button and it is wired
  local closeBtn
  for _, b in ipairs(popup:GetChildren()) do
    if b.ClassName == "TextButton" and tostring(b.Text) == "" then closeBtn = b end
  end
  assertTrue(closeBtn ~= nil, "the setup popup has no close control")
  assertTrue(#closeBtn.Activated.handlers > 0, "the close button is connected to nothing - it cannot close the popup")
  closeBtn.Activated:Fire()
  _G.__advance(1)
  if popup.Visible ~= false then
    print("DBG close children:", #closeBtn.Activated.handlers, "uiErrors:", table.concat(_G.__uiErrors, "|"))
    local btns = {}
    for _, b in ipairs(popup:GetChildren()) do
      if b.ClassName == "TextButton" then btns[#btns+1] = "'" .. tostring(b.Text) .. "'" end
    end
    print("DBG popup buttons:", table.concat(btns, ","))
  end
  assertTrue(popup.Visible == false, "pressing close did not hide the popup")

  -- 2. the line is selectable but NOT editable
  local lineBox
  for _, tb in ipairs(popup:GetChildren()) do
    if tb.ClassName == "TextBox" then
      if string.find(tostring(tb.Text), "golem%-bridge connect") then lineBox = tb end
    end
  end
  assertTrue(lineBox ~= nil, "the setup line is not shown")
  assertTrue(lineBox.TextEditable == false, "the setup line is editable - it must be selectable only")
  assertTrue(lineBox.ClearTextOnFocus ~= true, "focusing the line would clear it")

  -- 3. COPY copies, and does not steal focus
  local copyBtn
  for _, b in ipairs(popup:GetChildren()) do
    if b.ClassName == "TextButton" and string.find(tostring(b.Text), "COPY") then copyBtn = b end
  end
  assertTrue(copyBtn ~= nil, "there is no copy button")
  _G.__clipboard = nil
  local focusedBefore = lineBox:IsFocused()
  copyBtn.Activated:Fire()
  local feedback = tostring(copyBtn.Text)
  assertTrue(_G.__clipboard ~= nil, "COPY did not put anything on the clipboard")
  assertTrue(string.find(_G.__clipboard, "golem%-bridge connect") ~= nil,
    "the clipboard does not hold the setup line: " .. tostring(_G.__clipboard))
  assertTrue(lineBox:IsFocused() == focusedBefore,
    "COPY stole focus - it must only copy")
  assertTrue(string.find(feedback, "COPIED") ~= nil,
    "COPY gave no feedback, text is now '" .. feedback .. "'")

  -- 4. ASK YOUR AI TO CONNECT must do something real, not return silently
  local askBtn
  for _, b in ipairs(popup:GetChildren()) do
    if b.ClassName == "TextButton" and string.find(tostring(b.Text), "ASK YOUR AI") then askBtn = b end
  end
  assertTrue(askBtn ~= nil, "there is no ASK YOUR AI button")
  _G.__clipboard = nil
  local before = tostring(askBtn.Text)
  askBtn.Activated:Fire()
  assertTrue(_G.__clipboard ~= nil, "ASK YOUR AI TO CONNECT did nothing at all")
  assertTrue(string.find(_G.__clipboard, "golem%-bridge connect") ~= nil,
    "ASK YOUR AI did not copy the line")
  assertTrue(tostring(askBtn.Text) ~= before, "ASK YOUR AI gave no feedback")

  -- 5. the master switch exists, stops the relay, and persists
  local toggle
  for _, b in ipairs(find(settings, function(n) return n.ClassName == "TextButton" end)) do
    if tostring(b.Text) == "ON" or tostring(b.Text) == "OFF" then toggle = b end
  end
  assertTrue(toggle ~= nil, "there is no on/off switch in Settings")
  assertTrue(tostring(toggle.Text) == "ON", "a fresh install must start ON")
  toggle.Activated:Fire()
  _G.__advance(2)
  assertTrue(tostring(toggle.Text) == "OFF", "the switch did not turn off")
  assertTrue(_G.plugin._settings.Golem_Enabled == false,
    "the off state was not persisted, so it would come back on after a restart")
  local offText = textOf(settings)
  assertTrue(string.find(offText, "off") ~= nil, "the panel does not say Golem is off")
  -- and back on
  toggle.Activated:Fire()
  _G.__advance(2)
  assertTrue(tostring(toggle.Text) == "ON", "the switch did not turn back on")
  assertTrue(_G.plugin._settings.Golem_Enabled == true, "turning back on was not persisted")

  assertTrue(#_G.__uiErrors == 0, "UI errors: " .. table.concat(_G.__uiErrors, " | "))
  print("UI OK - close works, copy only copies, the line is read-only, the switch persists")
end

return M
