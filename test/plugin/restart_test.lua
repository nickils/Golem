-- A saved OFF must still be off after the plugin reloads, or the switch is a
-- lie: the user turns it off, restarts Studio, and the relay is live again.
local M = {}

local polls = 0
local function installTransport()
  _G.__httpReply = function(req)
    local url = req.Url or ""
    if string.find(url, "/cmd%.json") then
      if (req.Method or "GET") == "POST" then return '{"name":"-k0"}' end
      polls = polls + 1
      return "null"
    end
    return "null"
  end
end

local function findToggle()
  local seen = {}
  local function walk(inst, depth)
    if depth > 12 or seen[inst] then return nil end
    seen[inst] = true
    if inst.ClassName == "TextButton" then
      local t = tostring(inst.Text)
      if t == "ON" or t == "OFF" then return inst end
    end
    for _, c in ipairs(inst:GetChildren()) do
      local got = walk(c, depth + 1)
      if got then return got end
    end
    return nil
  end
  for _, inst in ipairs(_G.__widgets or {}) do
    local got = walk(inst, 0)
    if got then return got end
  end
  return nil
end

function M.run()
  __chunk_shim()
  _G.__jsonEncode = __chunk_json().encode
  _G.__jsonDecode = __chunk_json().decode
  installTransport()
  _G.__newThread(__chunk_plugin)
  _G.__advance(4)
  assert(polls > 0, "a fresh install should start polling")

  local toggle = findToggle()
  assert(toggle ~= nil, "no power toggle")
  assert(tostring(toggle.Text) == "ON", "should start ON")
  toggle.Activated:Fire()
  _G.__advance(2)
  assert(tostring(toggle.Text) == "OFF", "did not turn off")
  assert(_G.plugin._settings["Golem_Enabled"] == false, "the off state was not saved")

  -- reload the plugin: a second run of the same chunk, same saved settings
  polls = 0
  _G.__widgets = {}
  _G.__newThread(__chunk_plugin)
  _G.__advance(8)
  local after = findToggle()
  assert(after ~= nil, "no power toggle after reload")
  assert(tostring(after.Text) == "OFF",
    "after a reload the plugin came back " .. tostring(after.Text) .. ", so a saved OFF is ignored")
  assert(polls == 0, "after a reload with OFF saved, the relay polled " .. tostring(polls) .. " times")

  print("RESTART OK - a saved OFF survives a reload: no polling, toggle stays OFF")
end
return M
