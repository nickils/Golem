-- The switch must be more than a label: off has to stop the relay from running
-- commands, and turning it back on has to resume.
local M = {}
function M.run()
  __chunk_shim()
  _G.__jsonEncode = __chunk_json().encode
  _G.__jsonDecode = __chunk_json().decode
  local results, pending, n = {}, {}, 0
  local seenChannels, channelCount = {}, 0
  local gets = 0
  _G.__httpReply = function(req)
    local url = req.Url or ""
    local chan = string.match(url, "/channels/(%x+)/")
    if chan ~= nil and not seenChannels[chan] then
      seenChannels[chan] = true
      channelCount = channelCount + 1
    end
    local method = req.Method or "GET"
    if string.find(url, "/cmd%.json") then
      if method == "POST" then return '{"name":"-k0"}' end
      gets = gets + 1
      return _G.__jsonEncode(pending)
    end
    if string.find(url, "/res%.json") then
      local body = _G.__jsonDecode(req.Body or "{}")
      if type(body) == "table" and body.id and body.timeoutMs == nil then
        results[#results + 1] = body
      end
      return '{"name":"-k9"}'
    end
    return "null"
  end
  _G.__newThread(__chunk_plugin)
  _G.__advance(4)

  local function send(op)
    n = n + 1
    local id = "w" .. n
    pending[string.format("-k%08d", 100 + n)] = {
      id = id, op = op, args = {}, ts = os.time() + 3600,
    }
    local before = #results
    for _ = 1, 30 do
      _G.__advance(0.5)
      if #results > before then return results[#results] end
    end
    return nil
  end

  local first = send("ping")
  assert(first ~= nil and first.ok, "ping should answer while the plugin is on")

  -- find the Settings toggle through the plugin's own UI tree
  local function findToggle()
    local seen = {}
    local function walk(inst, depth)
      if depth > 12 or seen[inst] then return nil end
      seen[inst] = true
      if inst.ClassName == "TextButton" and tostring(inst.Text) == "ON"
        or (inst.ClassName == "TextButton" and tostring(inst.Text) == "OFF") then
        return inst
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

  local toggle = findToggle()
  assert(toggle ~= nil, "could not find the power toggle")
  assert(tostring(toggle.Text) == "ON", "the plugin should start ON, got " .. tostring(toggle.Text))
  toggle.Activated:Fire()
  _G.__advance(1)
  assert(tostring(toggle.Text) == "OFF", "the toggle did not paint OFF")

  local chanAfterOff = nil
  local afterOff = send("ping")
  assert(afterOff == nil, "a command still ran while the plugin was switched off")

  toggle.Activated:Fire()
  _G.__advance(2)
  local afterOn = send("ping")
  assert(afterOn ~= nil and afterOn.ok, "commands did not resume after switching back on")

  -- the old channel must be dead: switching off retires it, so a stale line
  -- held by an AI cannot wake the plugin without a new id
  assert(channelCount >= 2, "switching off did not move to a fresh channel (still " .. tostring(channelCount) .. ")")
  print("SWITCH OK - off stops the relay, retires the channel, and on resumes")
end
return M
