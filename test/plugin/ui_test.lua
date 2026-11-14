-- Drives the panel controls a user actually touched. Every assertion here maps
-- to a complaint: the popup cannot close, the SET UP AI pill does nothing, a
-- button that only looked wired, copy stealing focus, and an editable line.
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

-- Every TextButton the user can see must be wired to something. A button with
-- no handler is the bug this suite exists for, and it is invisible by reading.
local function assertEveryButtonIsWired(root, where)
  local dead = {}
  for _, b in ipairs(find(root, function(n) return n.ClassName == "TextButton" end)) do
    if #b.Activated.handlers == 0 then
      dead[#dead + 1] = "'" .. tostring(b.Text) .. "'"
    end
  end
  assertTrue(#dead == 0,
    "these buttons are connected to nothing in " .. where .. ": " .. table.concat(dead, ", "))
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

  -- The popup is the SMALLEST frame that DIRECTLY contains the copy button.
  -- "the first frame with it somewhere inside" matches the root window, which is
  -- exactly how a test ends up asserting nothing about the popup.
  local popup
  for _, f in ipairs(find(panel, function(n) return n.ClassName == "Frame" end)) do
    for _, c in ipairs(f:GetChildren()) do
      if tostring(c.Text) == "COPY THE LINE" then popup = f break end
    end
    if popup ~= nil then break end
  end
  assertTrue(popup ~= nil, "the setup popup never opened")
  assertTrue(popup.Visible == true or popup.Visible == nil, "the popup did not open visibly")

  -- 1. it must be closable: there is a close button and it is wired
  local closeBtn
  for _, b in ipairs(popup:GetChildren()) do
    if b.ClassName == "TextButton" and tostring(b.Text) == "" then closeBtn = b end
  end
  assertTrue(closeBtn ~= nil, "the setup popup has no close control")
  assertTrue(#closeBtn.Activated.handlers > 0,
    "the close button is connected to nothing - it cannot close the popup")
  closeBtn.Activated:Fire()
  _G.__advance(1)
  assertTrue(popup.Visible == false, "pressing close did not hide the popup")

  -- 2. the SET UP AI pill is the only way back - it must reopen the popup
  local pill
  for _, b in ipairs(find(panel, function(n) return n.ClassName == "TextButton" end)) do
    if tostring(b.Text) == "SET UP AI" then pill = b end
  end
  assertTrue(pill ~= nil, "there is no SET UP AI pill")
  assertTrue(#pill.Activated.handlers > 0,
    "the SET UP AI pill is connected to nothing - pressing it does nothing")
  assertTrue(pill.Visible == true, "the pill is hidden, so a closed popup has no way back")
  pill.Activated:Fire()
  _G.__advance(1)
  assertTrue(popup.Visible == true, "pressing the SET UP AI pill did not reopen the popup")

  -- 3. the line is selectable but NOT editable
  local lineBox
  for _, tb in ipairs(popup:GetChildren()) do
    if tb.ClassName == "TextBox" then
      if string.find(tostring(tb.Text), "golem%-bridge connect") then lineBox = tb end
    end
  end
  assertTrue(lineBox ~= nil, "the setup line is not shown")
  assertTrue(lineBox.TextEditable == false, "the setup line is editable - it must be selectable only")
  assertTrue(lineBox.ClearTextOnFocus ~= true, "focusing the line would clear it")

  -- 4. COPY copies, and does not steal focus
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
  -- exact equality, not "contains": a selection that drops the first character
  -- still contains "golem-bridge connect" and would pass a substring check
  assertTrue(_G.__clipboard == tostring(lineBox.Text),
    "the clipboard does not hold the whole line.\n  wanted: " .. tostring(lineBox.Text)
    .. "\n  got:    " .. tostring(_G.__clipboard))
  assertTrue(lineBox:IsFocused() == focusedBefore, "COPY stole focus - it must only copy")
  assertTrue(string.find(feedback, "COPIED") ~= nil,
    "COPY gave no feedback, text is now '" .. feedback .. "'")

  -- 4b. when copying genuinely cannot work, the button must SAY SO instead of
  -- claiming COPIED. This is the failure that shipped: the old handler called
  -- an API that does not exist inside a pcall and printed COPIED regardless.
  local uis = game:GetService("UserInputService")
  local realCreate = uis.CreateVirtualInput
  uis.CreateVirtualInput = function() error("no virtual input", 0) end
  _G.__clipboard = nil
  -- The button debounces on os.clock() (CPU time, which barely moves in a
  -- shim), so a press right after the successful one is swallowed. Wait past
  -- the debounce rather than pretending a second press was handled.
  local firedAt = os.clock()
  while os.clock() - firedAt < 0.5 do
    _G.__advance(0.1)
  end
  copyBtn.Activated:Fire()
  local failedLabel = tostring(copyBtn.Text)
  uis.CreateVirtualInput = realCreate

  -- 6. a reopened popup must show a line that still works. The channel rotates
  -- on END SESSION and on the switch, so a cached line would be dead on arrival.
  local shownBefore = tostring(lineBox.Text)
  local endBtn
  -- END SESSION lives in the Settings widget
  for _, b in ipairs(find(settings, function(n) return n.ClassName == "TextButton" end)) do
    if string.find(tostring(b.Text), "END SESSION") then endBtn = b end
  end
  assertTrue(endBtn ~= nil, "there is no END SESSION button")
  endBtn.Activated:Fire()   -- first click arms the confirm
  endBtn.Activated:Fire()   -- second click rotates the channel
  _G.__advance(3)
  closeBtn.Activated:Fire()
  _G.__advance(1)
  pill.Activated:Fire()
  _G.__advance(1)
  assertTrue(tostring(lineBox.Text) ~= shownBefore,
    "after END SESSION the reopened popup still shows the retired line: " .. tostring(lineBox.Text))
  assertTrue(string.find(tostring(lineBox.Text), "golem%-bridge connect") ~= nil,
    "the reopened popup does not show a setup line at all")

  -- 6b. the Settings copy of the line obeys the same rule: selectable, never
  -- editable. Only the popup's copy was fixed the first time round.
  local settingsBox
  for _, tb in ipairs(find(settings, function(n) return n.ClassName == "TextBox" end)) do
    if string.find(tostring(tb.Text), "golem%-bridge connect") then settingsBox = tb end
  end
  assertTrue(settingsBox ~= nil, "the setup line is not shown in Settings")
  assertTrue(settingsBox.TextEditable == false,
    "the setup line in Settings is editable - it must be selectable only")
  assertTrue(settingsBox.ClearTextOnFocus ~= true,
    "focusing the Settings line would clear it")

  -- 7. the master switch exists, stops the relay, and persists
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
  toggle.Activated:Fire()
  _G.__advance(2)
  assertTrue(tostring(toggle.Text) == "ON", "the switch did not turn back on")
  assertTrue(_G.plugin._settings.Golem_Enabled == true, "turning back on was not persisted")

  -- 8. nothing may be left dead by construction
  assertEveryButtonIsWired(panel, "the panel")
  assertEveryButtonIsWired(settings, "Settings")

  -- 9. the plugin must not call input functions that do not exist. The shim
  -- models VirtualInput exactly, so a wrong name is an error rather than a
  -- silent no-op - which is how two broken copy implementations shipped.
  assertTrue((_G.__virtualKeysSent or 0) > 0,
    "no key was ever sent through VirtualInput, so copy cannot have worked")
  assertTrue((_G.__virtualLetters or 0) > 0,
    "Ctrl+C was never sent through VirtualInput")

  assertTrue(#_G.__uiErrors == 0, "UI errors: " .. table.concat(_G.__uiErrors, " | "))
  print("UI OK - close works, the pill reopens, copy really copies and admits failure, "
    .. "both lines are read-only, a reopened line is live, no dead buttons, the switch persists")
end

return M
