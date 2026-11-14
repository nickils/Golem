-- Minimal JSON for the harness. Strings only, which is all the relay moves.
local M = {}
local function esc(s)
  s = string.gsub(s, "\\", "\\\\")
  s = string.gsub(s, '"', '\\"')
  s = string.gsub(s, "\n", "\\n")
  s = string.gsub(s, "\r", "\\r")
  s = string.gsub(s, "\t", "\\t")
  return s
end
local function isArray(t)
  if next(t) == nil then return true end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n == #t
end
function M.encode(v)
  local kind = type(v)
  if v == nil then return "null" end
  if kind == "boolean" then return tostring(v) end
  if kind == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if v == math.floor(v) and math.abs(v) < 1e15 then return string.format("%d", v) end
    return string.format("%.14g", v)
  end
  if kind == "string" then return '"' .. esc(v) .. '"' end
  if kind == "table" then
    if isArray(v) then
      local out = {}
      for i = 1, #v do out[#out + 1] = M.encode(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    local out = {}
    for k, val in pairs(v) do
      if type(k) == "string" then
        out[#out + 1] = '"' .. esc(k) .. '":' .. M.encode(val)
      end
    end
    return "{" .. table.concat(out, ",") .. "}"
  end
  return '"<' .. kind .. '>"'
end

local pos, str
local function skip() while pos <= #str and string.find(string.sub(str, pos, pos), "%s") do pos = pos + 1 end end
local parse
local function parseString()
  pos = pos + 1
  local out = {}
  while true do
    local c = string.sub(str, pos, pos)
    if c == "" then error("unterminated string") end
    if c == '"' then pos = pos + 1 break end
    if c == "\\" then
      local n = string.sub(str, pos + 1, pos + 1)
      pos = pos + 2
      if n == "n" then out[#out + 1] = "\n"
      elseif n == "t" then out[#out + 1] = "\t"
      elseif n == "r" then out[#out + 1] = "\r"
      elseif n == "u" then
        local hex = string.sub(str, pos, pos + 3)
        pos = pos + 4
        out[#out + 1] = string.char(tonumber(hex, 16) % 128)
      else out[#out + 1] = n end
    else
      out[#out + 1] = c
      pos = pos + 1
    end
  end
  return table.concat(out)
end
parse = function()
  skip()
  local c = string.sub(str, pos, pos)
  if c == "{" then
    pos = pos + 1
    local out = {}
    skip()
    if string.sub(str, pos, pos) == "}" then pos = pos + 1 return out end
    while true do
      skip()
      local key = parseString()
      skip()
      pos = pos + 1 -- colon
      out[key] = parse()
      skip()
      local sep = string.sub(str, pos, pos)
      pos = pos + 1
      if sep == "}" then break end
    end
    return out
  elseif c == "[" then
    pos = pos + 1
    local out = {}
    skip()
    if string.sub(str, pos, pos) == "]" then pos = pos + 1 return out end
    while true do
      out[#out + 1] = parse()
      skip()
      local sep = string.sub(str, pos, pos)
      pos = pos + 1
      if sep == "]" then break end
    end
    return out
  elseif c == '"' then
    return parseString()
  elseif string.sub(str, pos, pos + 3) == "true" then pos = pos + 4 return true
  elseif string.sub(str, pos, pos + 4) == "false" then pos = pos + 5 return false
  elseif string.sub(str, pos, pos + 3) == "null" then pos = pos + 4 return nil
  else
    local num = string.match(str, "^%-?%d+%.?%d*[eE]?[%-+]?%d*", pos)
    if num == nil then error("bad json at " .. pos) end
    pos = pos + #num
    return tonumber(num)
  end
end
function M.decode(s)
  if type(s) ~= "string" or s == "" then return nil end
  pos, str = 1, s
  local ok, value = pcall(parse)
  if not ok then return nil end
  return value
end
return M
