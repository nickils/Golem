-- Drives every command through the plugin the same way the relay does.
local M = {}
local commands = {
  -- basics
  { op = "ping", args = {} }, { op = "debug", args = {} },
  { op = "run", args = { code = "return 1", target = "editor" } },
  { op = "list", args = { path = "game" } }, { op = "tree", args = { path = "game", depth = 2 } },
  { op = "count", args = {} }, { op = "undo", args = {} }, { op = "redo", args = {} },
  { op = "create", args = { class = "Part", parent = "Workspace", name = "T" } },
  { op = "selection", args = {} }, { op = "waypoint", args = {} },
  { op = "playstate", args = {}, play = true }, { op = "logs", args = {} },
  { op = "run_script", args = { code = "return 1", runContext = "server", name = "P" }, play = true },
  { op = "run_list", args = {}, play = true }, { op = "run_remove", args = { name = "P" }, play = true },
  -- a model to operate on
  { op = "create", args = { class = "Script", parent = "Workspace", name = "S", source = "print(1)" } },
  { op = "read", args = { path = "Workspace/S" } },
  { op = "write", args = { path = "Workspace/S", source = "print(2)" } },
  { op = "script", args = { parent = "Workspace", name = "S2", source = "return 1" } },
  { op = "rename", args = { path = "Workspace/S2", name = "S3" } },
  { op = "find", args = { query = "S3", scope = "Workspace" } },
  { op = "grep", args = { pattern = "print", scope = "Workspace" } },
  { op = "attributes", args = { path = "Workspace/T", set = { hp = 5 } } },
  { op = "tag", args = { path = "Workspace/T", tag = "hero" } },
  { op = "create", args = { class = "Part", parent = "Workspace", name = "Part A" } },
  { op = "create", args = { class = "Part", parent = "Workspace", name = "Part B" } },
  { op = "place", args = { path = "Workspace/Part B", position = { x = 4, y = 0, z = 0 } } },
  -- transforms
  { op = "rotate", args = { path = "Workspace/T", degrees = 90, axis = "y" } },
  { op = "shift", args = { path = "Workspace/T", offset = { x = 1, y = 2, z = 3 } } },
  { op = "scale", args = { path = "Workspace/T", factor = 2 } },
  { op = "place", args = { path = "Workspace/T", position = { x = 1, y = 2, z = 3 } } },
  { op = "face", args = { path = "Workspace/T", target = { x = 0, y = 0, z = -10 } } },
  { op = "set_pivot", args = { path = "Workspace/T", position = { x = 0, y = 5, z = 0 } } },
  { op = "anchor", args = { path = "Workspace/T", anchored = true } },
  { op = "collide", args = { path = "Workspace/T", canCollide = false } },
  { op = "paint", args = { path = "Workspace/T", color = { 255, 0, 0 } } },
  { op = "look", args = { path = "Workspace/T" } },
  { op = "duplicate", args = { path = "Workspace/T", count = 2 } },
  { op = "rename", args = { path = "Workspace/T 2", name = "T2" } },
  { op = "match", args = { from = "Workspace/T", to = "Workspace/T2" } },
  { op = "scatter", args = { path = "Workspace/T", count = 3, radius = 5 } },
  { op = "group", args = { paths = { "Workspace/T" }, name = "Grp" } },
  { op = "group", args = { paths = { "Workspace/Part A", "Workspace/Part B" }, name = "Welded" } },
  { op = "tree", args = { path = "Workspace/Welded", depth = 1 } },
  { op = "weld", args = { path = "Workspace/Welded" } },
  { op = "hitbox", args = { path = "Workspace/Grp/T" } },
  -- effects and ui
  { op = "light", args = { path = "Workspace/Grp/T", type = "point" } },
  { op = "particles", args = { path = "Workspace/Grp/T", preset = "sparks" } },
  { op = "prompt", args = { path = "Workspace/Grp/T", text = "Use" } },
  { op = "trail", args = { path = "Workspace/Grp/T" } },
  { op = "explosion", args = { position = { x = 0, y = 10, z = 0 } } },
  { op = "beam", args = { from = "Workspace/Grp/T", to = "Workspace/T2" } },
  { op = "sound", args = { id = "123", parent = "Workspace" } },
  { op = "sign", args = { text = "HELLO", parent = "Workspace" } },
  { op = "terrain", args = { shape = "block", position = { x = 0, y = 0, z = 0 }, size = { x = 4, y = 4, z = 4 } } },
  { op = "ui_screen", args = { parent = "StarterGui", name = "HUD" } },
  { op = "ui_frame", args = { parent = "StarterGui/HUD", name = "F" } },
  { op = "ui_label", args = { parent = "StarterGui/HUD/F", name = "L", text = "hi" } },
  { op = "ui_button", args = { parent = "StarterGui/HUD/F", name = "B", text = "go" } },
  { op = "ui_input", args = { parent = "StarterGui/HUD/F", name = "I" } },
  { op = "ui_list", args = { parent = "StarterGui/HUD/F" } },
  { op = "delete", args = { path = "Workspace/T2" } },
}
function M.run()
  __chunk_shim()
  _G.__jsonEncode = __chunk_json().encode
  _G.__jsonDecode = __chunk_json().decode
  local results, posted = {}, {}
  local guestRes, guestN = {}, 0
  guest = function(body)
    local op = body.op
    if op == "hello" then return { ok = true, role = "shim", play = true } end
    if op == "logs" then return { ok = true, logs = {}, count = 0 } end
    if op == "run" then return { ok = true, mode = "inline", name = (body.args and body.args.name) or "run1", scriptId = "run1" } end
    if op == "run_list" then return { ok = true, scripts = { { name = "run1" } } } end
    if op == "uninstall" then return { ok = true, removed = body.args and body.args.name } end
    if op == "input" then return { ok = true } end
    return { ok = false, error = "shim guest does not implement " .. tostring(op) }
  end
  local channel = "abcdefabcdefabcd"
  local function key(n) return string.format("-k%08d", n) end
  local pending, n = {}, 0
  _G.__httpReply = function(req)
    local url = req.Url or ""
    local method = req.Method or "GET"
    if string.find(url, "/guest/", 1, true) then
      local body = _G.__jsonDecode(req.Body or "{}")
      if method == "POST" and type(body) == "table" and body.op then
        local ok, res = pcall(function() return guest(body) end)
        local envelope = { id = body.id, v = "shim", op = body.op }
        if ok and type(res) == "table" then
          -- never let a payload field shadow the envelope's routing identity
          for k2, v2 in pairs(res) do if k2 ~= "id" then envelope[k2] = v2 end end
        else
          envelope.ok = false
          envelope.error = tostring(res)
        end
        -- Firebase assigns the push key; the answer written afterwards sorts
        -- after it, which is exactly what the plugin's waiter expects
        local replyKey = string.format("-g%08d", guestN)
        guestN = guestN + 1
        local answerKey = string.format("-g%08d", guestN)
        guestN = guestN + 1
        guestRes[answerKey] = envelope
        return _G.__jsonEncode({ name = replyKey })
      end
      if string.find(url, "shallow", 1, true) then
        local out = {}
        for k in pairs(guestRes) do out[k] = true end
        if next(out) == nil then return "null" end
        return _G.__jsonEncode(out)
      end
      local k = string.match(url or "", "/guest/[^/]+/res/([^/%?]+)")
      k = k and string.gsub(k, "%.json$", "")
      if k then
        local e = guestRes[k]
        return e ~= nil and _G.__jsonEncode(e) or "null"
      end
      -- listing without shallow: the waiter only needs the keys
      local out = {}
      for kk, v in pairs(guestRes) do out[kk] = v end
      if next(out) == nil then return "null" end
      return _G.__jsonEncode(out)
    end
    if string.find(url, "/cmd%.json") then
      if method == "POST" then return '{"name":"-k1"}' end
      local out = {}
      local startAt = nil
      local sp = string.find(url or "", "startAt=", 1, true)
      if sp then
        local tail = string.match(string.sub(url, sp), "%-(k%d+)")
        if tail then startAt = "-" .. tail end
      end
      for k, v in pairs(pending) do
        if startAt == nil or k >= startAt then out[k] = v end
      end
      if next(out) == nil then return "null" end
      return _G.__jsonEncode(out)
    end
    if string.find(url, "/res%.json") and not string.find(url, "shallow") then
      local body = _G.__jsonDecode(req.Body or "{}")
      -- guestExec stamps timeoutMs; the plugin's own op replies never do
      if type(body) == "table" and body.op and body.timeoutMs ~= nil and method == "POST" then
        -- the plugin's guestExec posts driver requests to this stream
        local ok, res = pcall(function() return guest(body) end)
        local envelope = { id = body.id, v = "shim", op = body.op }
        if ok and type(res) == "table" then
          -- never let a payload field shadow the envelope's routing identity
          for k2, v2 in pairs(res) do if k2 ~= "id" then envelope[k2] = v2 end end
        else
          envelope.ok = false
          envelope.error = tostring(res)
        end
        local replyKey = string.format("-g%08d", guestN)
        guestN = guestN + 1
        local answerKey = string.format("-g%08d", guestN)
        guestN = guestN + 1
        guestRes[answerKey] = envelope
        print("GUEST " .. tostring(body.op) .. " -> " .. answerKey)
        return _G.__jsonEncode({ name = replyKey })
      end
      if type(body) == "table" and body.id then results[#results + 1] = body end
      return '{"name":"-k2"}'
    end
    if string.find(url, "/cmd/") then return "null" end
    if string.find(url, "/res/") and not string.find(url, "/res%.json") then
      local k = string.match(url or "", "/res/([^/%?]+)")
      local entry = guestRes[k]
      return entry ~= nil and _G.__jsonEncode(entry) or "null"
    end
    if string.find(url, "/res") and string.find(url, "shallow") then
      local out = {}
      for k in pairs(guestRes) do out[k] = true end
      if next(out) == nil then return "null" end
      return _G.__jsonEncode(out)
    end
    if string.find(url, "/beacons") then return "null" end
    return "null"
  end
  local realReply = _G.__httpReply
  _G.__httpReply = function(req)
    local r = realReply(req)
    if string.find(req.Url or "", "cmd%.json") and (req.Method or "GET") == "GET" then
      print("GET->" .. tostring(r))
    end
    return r
  end
  _G.__newThread(__chunk_plugin)
  _G.__advance(4)

  local runS = _G.game:GetService("RunService")
  local chs = _G.game:GetService("ChangeHistoryService")
  chs._undo[#chs._undo + 1] = { what = "seed" }
  local bad = 0
  for _, cmd in ipairs(commands) do
    local before = #results
    n = n + 1
    -- editor ops need edit mode; the play-test ops only run with a live session
    runS._running = cmd.play == true

    local id = "s" .. n
    pending[key(n)] = { id = id, op = cmd.op, args = cmd.args, ts = os.time() + 3600 }
    local waited = 0
    while #results == before and waited < 40 do _G.__advance(0.5) waited = waited + 1 end
    if #results == before then
      print(string.format("HANG %-12s", cmd.op)); bad = bad + 1
    else
      local r = results[#results]
      if r.id ~= id then
        print(string.format("STALE %-12s wanted %s got %s", cmd.op, id, tostring(r.id)))
      end
      if r.ok then
        print(string.format("OK   %-12s", cmd.op))
        if cmd.op == "group" or cmd.op == "tree" then print("  -> " .. (_G.__jsonEncode(r):gsub("\n", ""))) end
      else
        print(string.format("ERR  %-12s %s", cmd.op, tostring(r.error)))
        bad = bad + 1
      end
    end
  end
  print(string.format("SWEEP: %d ops, %d errored/hung", #commands, bad))
  assert(bad == 0, "sweep found failures")
end
return M
