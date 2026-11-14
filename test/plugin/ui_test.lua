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

  -- The popup is the SMALLEST frame that DIRECTLY contains the setup line.
  -- "the first frame with it somewhere inside" matches the root window, which is
  -- exactly how a test ends up asserting nothing about the popup.
  local popup
  for _, f in ipairs(find(panel, function(n) return n.ClassName == "Frame" end)) do
    for _, c in ipairs(f:GetChildren()) do
      if c.ClassName == "TextBox" and string.find(tostring(c.Text), "golem%-bridge connect") then
        popup = f break
      end
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

  -- 4. there is no copy button, and the line tells the user what to do. A
  -- button that may silently copy nothing is worse than no button.
  for _, b in ipairs(find(panel, function(n) return n.ClassName == "TextButton" end)) do
    local t = tostring(b.Text)
    assertTrue(string.find(t, "COPY") == nil and string.find(t, "ASK YOUR AI") == nil,
      "a copy/ask button is still present: '" .. t .. "'")
  end
  local lineHelp = textOf(popup)
  assertTrue(string.find(lineHelp, "Ctrl%+C") ~= nil,
    "the panel does not tell the user to press Ctrl+C:\n" .. lineHelp)

  -- 4b. selecting is made easy: focusing the line selects all of it, so Ctrl+C
  -- is the only keystroke needed.
  lineBox.SelectionStart = -1
  lineBox:CaptureFocus()
  assertTrue(lineBox.SelectionStart == 1,
    "focusing the line did not select it (SelectionStart = " .. tostring(lineBox.SelectionStart) .. ")")
  assertTrue(lineBox.CursorPosition == #lineBox.Text + 1,
    "focusing the line did not put the caret at the end (CursorPosition = "
    .. tostring(lineBox.CursorPosition) .. ")")
  lineBox:ReleaseFocus()

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

  assertTrue(#_G.__uiErrors == 0, "UI errors: " .. table.concat(_G.__uiErrors, " | "))
  print("UI OK - close works, the pill reopens, no copy button and the line says Ctrl+C, "
    .. "focus selects the line, both lines are read-only, a reopened line is live, "
    .. "no dead buttons, the switch persists")
end

return M
