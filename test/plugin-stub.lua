-- Minimal Roblox object model for running plugin/Golem.lua outside Studio.
-- Executed by test/plugin-smoke.js under fengari (Lua 5.3).
--
-- It is deliberately strict: assigning a property Studio does not know
-- raises an error, which catches the classic plugin bug of stashing custom
-- fields on Instances instead of using tables or attributes.

local function Signal()
	local signal = { handlers = {} }
	function signal:Connect(fn)
		table.insert(self.handlers, fn)
		return { Disconnect = function() end }
	end
	function signal:Fire(...)
		for _, fn in ipairs(self.handlers) do
			fn(...)
		end
	end
	return signal
end

-- ---------------------------------------------------------------- datatypes

local Color3MT = {
	__tostring = function(self)
		return string.format("Color3(%d, %d, %d)", math.floor(self.r * 255), math.floor(self.g * 255), math.floor(self.b * 255))
	end,
}
local function color(r, g, b)
	return setmetatable({ r = r or 0, g = g or 0, b = b or 0 }, Color3MT)
end
Color3 = setmetatable({}, {
	__call = function(_, r, g, b)
		return color(r, g, b)
	end,
})
Color3.fromRGB = function(r, g, b)
	return color(r / 255, g / 255, b / 255)
end
Color3.new = color

local function udim(scale, offset)
	return { Scale = scale or 0, Offset = offset or 0 }
end
UDim = setmetatable({ new = udim }, {
	__call = function(_, scale, offset)
		return udim(scale, offset)
	end,
})
local function udim2(xs, xo, ys, yo)
	return { X = udim(xs, xo), Y = udim(ys, yo) }
end
UDim2 = setmetatable({ new = udim2 }, {
	__call = function(_, xs, xo, ys, yo)
		return udim2(xs, xo, ys, yo)
	end,
})
local function vector(x, y, z)
	return { X = x or 0, Y = y or 0, Z = z or 0 }
end
Vector3 = setmetatable({ new = vector }, {
	__call = function(_, x, y, z)
		return vector(x, y, z)
	end,
})

local CFrameMT = {
	__mul = function(_, other)
		return other
	end,
}
local function cframe(x, y, z)
	return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, CFrameMT)
end
CFrame = setmetatable({ new = cframe }, {
	__call = function(_, x, y, z)
		return cframe(x, y, z)
	end,
})

local EnumValueMT = {
	__tostring = function(self)
		return "Enum." .. self.__path
	end,
}
Enum = setmetatable({}, {
	__index = function(category, name)
		local values = { __path = name }
		setmetatable(values, {
			__index = function(cache, key)
				local value = setmetatable({ __path = name .. "." .. key }, EnumValueMT)
				rawset(cache, key, value)
				return value
			end,
		})
		rawset(category, name, values)
		return values
	end,
})

DockWidgetPluginGuiInfo = {
	new = function(...)
		return { ... }
	end,
}

-- ---------------------------------------------------------------- instances

local DEFAULTS = {
	Frame = {
		BackgroundColor3 = Color3(0, 0, 0),
		BackgroundTransparency = 0,
		BorderSizePixel = 1,
		Size = UDim2(0, 0, 0, 0),
		Position = UDim2(0, 0, 0, 0),
		Visible = true,
		ClipsDescendants = false,
		AutomaticSize = Enum.AutomaticSize.None,
	},
	ScrollingFrame = {
		BackgroundColor3 = Color3(0, 0, 0),
		BackgroundTransparency = 0,
		BorderSizePixel = 0,
		Size = UDim2(0, 0, 0, 0),
		Position = UDim2(0, 0, 0, 0),
		Visible = true,
		CanvasSize = UDim2(0, 0, 0, 0),
		AutomaticCanvasSize = Enum.AutomaticSize.None,
		ScrollBarThickness = 12,
		ScrollBarImageColor3 = Color3(1, 1, 1),
		ScrollingDirection = Enum.ScrollingDirection.Y,
	},
	TextLabel = {
		BackgroundColor3 = Color3(0, 0, 0),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Size = UDim2(0, 0, 0, 0),
		Position = UDim2(0, 0, 0, 0),
		Visible = true,
		Text = "",
		TextSize = 14,
		TextColor3 = Color3(0, 0, 0),
		Font = Enum.Font.Legacy,
		TextWrapped = false,
		TextXAlignment = Enum.TextXAlignment.Center,
		TextYAlignment = Enum.TextYAlignment.Center,
		AutomaticSize = Enum.AutomaticSize.None,
	},
	TextButton = {
		BackgroundColor3 = Color3(0, 0, 0),
		BackgroundTransparency = 0,
		BorderSizePixel = 0,
		Size = UDim2(0, 0, 0, 0),
		Position = UDim2(0, 0, 0, 0),
		Visible = true,
		Text = "",
		TextSize = 14,
		TextColor3 = Color3(0, 0, 0),
		Font = Enum.Font.Legacy,
		AutoButtonColor = true,
		AutomaticSize = Enum.AutomaticSize.None,
	},
	TextBox = {
		BackgroundColor3 = Color3(0, 0, 0),
		BackgroundTransparency = 0,
		BorderSizePixel = 0,
		Size = UDim2(0, 0, 0, 0),
		Position = UDim2(0, 0, 0, 0),
		Visible = true,
		Text = "",
		TextSize = 14,
		TextColor3 = Color3(0, 0, 0),
		Font = Enum.Font.Legacy,
		TextWrapped = false,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Center,
		ClearTextOnFocus = true,
		MultiLine = false,
		PlaceholderText = "",
		PlaceholderColor3 = Color3(0.5, 0.5, 0.5),
	},
	UICorner = { CornerRadius = UDim(0, 0) },
	UIStroke = {
		ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual,
		Color = Color3(0, 0, 0),
		Thickness = 1,
		Transparency = 0,
	},
	UIPadding = {
		PaddingTop = UDim(0, 0),
		PaddingBottom = UDim(0, 0),
		PaddingLeft = UDim(0, 0),
		PaddingRight = UDim(0, 0),
	},
	UIListLayout = {
		Padding = UDim(0, 0),
		FillDirection = Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		VerticalAlignment = Enum.VerticalAlignment.Top,
		HorizontalAlignment = Enum.HorizontalAlignment.Left,
	},
	Part = {
		Name = "Part",
		Size = Vector3(1, 1, 1),
		Anchored = false,
		CFrame = CFrame(0, 0, 0),
	},
	Model = { Name = "Model" },
	Folder = { Name = "Folder" },
	Workspace = { Name = "Workspace", CurrentCamera = nil },
	Camera = { Name = "Camera", CFrame = CFrame(0, 0, 0) },
	Decal = { Name = "Decal", Texture = "", Face = Enum.NormalId.Front },
	Sound = { Name = "Sound", SoundId = "" },
	Animation = { Name = "Animation", AnimationId = "" },
	SpecialMesh = { Name = "SpecialMesh", MeshId = "" },
	DockWidgetPluginGui = { Name = "DockWidgetPluginGui", Title = "", Enabled = true },
}

local ALLOWED = {
	Name = true,
	Parent = true,
	Size = true,
	Position = true,
	LayoutOrder = true,
	Visible = true,
	BackgroundColor3 = true,
	BackgroundTransparency = true,
	BorderSizePixel = true,
	AutomaticSize = true,
	ClipsDescendants = true,
	CanvasSize = true,
	AutomaticCanvasSize = true,
	ScrollBarThickness = true,
	ScrollBarImageColor3 = true,
	ScrollingDirection = true,
	Text = true,
	TextSize = true,
	TextColor3 = true,
	Font = true,
	TextWrapped = true,
	TextXAlignment = true,
	TextYAlignment = true,
	TextTruncate = true,
	AutoButtonColor = true,
	ClearTextOnFocus = true,
	MultiLine = true,
	PlaceholderText = true,
	PlaceholderColor3 = true,
	CornerRadius = true,
	ApplyStrokeMode = true,
	Color = true,
	Thickness = true,
	Transparency = true,
	Padding = true,
	PaddingTop = true,
	PaddingBottom = true,
	PaddingLeft = true,
	PaddingRight = true,
	FillDirection = true,
	SortOrder = true,
	VerticalAlignment = true,
	HorizontalAlignment = true,
	Texture = true,
	Face = true,
	SoundId = true,
	MeshId = true,
	AnimationId = true,
	Anchored = true,
	CFrame = true,
	CurrentCamera = true,
	Title = true,
	Enabled = true,
}

local EVENTS = {
	MouseButton1Click = true,
	MouseEnter = true,
	MouseLeave = true,
	MouseButton1Down = true,
	MouseButton1Up = true,
	Click = true,
	Changed = true,
	InputBegan = true,
	FocusLost = true,
	SelectionChanged = true,
}

local HIERARCHY = {
	Part = { BasePart = true },
	Model = {},
	Folder = {},
	Frame = { GuiObject = true },
	TextLabel = { GuiObject = true },
	TextButton = { GuiObject = true, GuiButton = true },
	TextBox = { GuiObject = true },
	ScrollingFrame = { GuiObject = true },
}

local function isA(self, className)
	if self.ClassName == className then
		return true
	end
	local parents = HIERARCHY[self.ClassName]
	return parents ~= nil and parents[className] == true
end

local function setParent(self, newParent)
	local oldParent = rawget(self, "__parent")
	if oldParent == newParent then
		return
	end
	if oldParent then
		local siblings = rawget(oldParent, "__children")
		for index, child in ipairs(siblings) do
			if child == self then
				table.remove(siblings, index)
				break
			end
		end
	end
	rawset(self, "__parent", newParent)
	if newParent then
		table.insert(rawget(newParent, "__children"), self)
	end
end

local newInstance

local METHODS = {
	GetChildren = function(self)
		local out = {}
		for _, child in ipairs(rawget(self, "__children")) do
			table.insert(out, child)
		end
		return out
	end,
	FindFirstChild = function(self, name)
		for _, child in ipairs(rawget(self, "__children")) do
			if child.Name == name then
				return child
			end
		end
		return nil
	end,
	FindFirstChildOfClass = function(self, className)
		for _, child in ipairs(rawget(self, "__children")) do
			if child.ClassName == className then
				return child
			end
		end
		return nil
	end,
	Destroy = function(self)
		local children = {}
		for _, child in ipairs(rawget(self, "__children")) do
			table.insert(children, child)
		end
		for _, child in ipairs(children) do
			child:Destroy()
		end
		setParent(self, nil)
		rawset(self, "__destroyed", true)
	end,
	IsA = isA,
	GetFullName = function(self)
		local parts = {}
		local node = self
		while node and node.ClassName ~= "DataModel" do
			table.insert(parts, 1, node.Name)
			node = node.Parent
		end
		return table.concat(parts, ".")
	end,
	SetAttribute = function(self, key, value)
		rawget(self, "__attrs")[key] = value
	end,
	GetAttribute = function(self, key)
		return rawget(self, "__attrs")[key]
	end,
	GetPropertyChangedSignal = function(self, key)
		local changed = rawget(self, "__changed")
		if not changed[key] then
			changed[key] = Signal()
		end
		return changed[key]
	end,
	BindToClose = function(self, fn)
		rawget(self, "__close").fn = fn
	end,
	GetService = function(self, name)
		local service = SERVICES[name]
		if not service then
			service = newInstance("Folder")
			service.Name = name
			SERVICES[name] = service
		end
		return service
	end,
}

local InstanceMT = {}

function newInstance(className)
	local self = {
		__class = className,
		__props = {},
		__children = {},
		__attrs = {},
		__signals = {},
		__changed = {},
		__close = {},
		__parent = nil,
		__name = className,
	}
	return setmetatable(self, InstanceMT)
end

InstanceMT.__index = function(self, key)
	if key == "ClassName" then
		return rawget(self, "__class")
	end
	if key == "Name" then
		return rawget(self, "__name")
	end
	if key == "Parent" then
		return rawget(self, "__parent")
	end
	local props = rawget(self, "__props")
	if props[key] ~= nil then
		return props[key]
	end
	local defaults = DEFAULTS[rawget(self, "__class")]
	if defaults and defaults[key] ~= nil then
		return defaults[key]
	end
	local method = METHODS[key]
	if method then
		return method
	end
	local signals = rawget(self, "__signals")
	if not signals[key] and EVENTS[key] then
		signals[key] = Signal()
	end
	return signals[key]
end

InstanceMT.__newindex = function(self, key, value)
	if key == "Parent" then
		setParent(self, value)
		return
	end
	if key == "Name" then
		rawset(self, "__name", tostring(value))
		return
	end
	if not ALLOWED[key] then
		error("Roblox has no property '" .. key .. "' on " .. tostring(rawget(self, "__class")), 2)
	end
	rawget(self, "__props")[key] = value
	local changed = rawget(self, "__changed")
	if changed[key] then
		changed[key]:Fire(value)
	end
end

Instance = {
	new = function(className)
		return newInstance(className)
	end,
}

-- ---------------------------------------------------------------- services

local selectionItems = {}
local clipboardValue = nil
settings = {}
SERVICES = {}

SERVICES.Selection = {
	Get = function()
		return selectionItems
	end,
	SelectionChanged = Signal(),
}
SERVICES.ChangeHistoryService = {
	TryBeginRecording = function()
		return "recording"
	end,
	FinishRecording = function() end,
	SetWaypoint = function() end,
}
SERVICES.InsertService = {
	LoadAsset = function(_, id)
		if tonumber(id) == 999 then
			error("asset not owned")
		end
		local model = newInstance("Model")
		model.Name = "Loaded"
		local child = newInstance("Model")
		child.Name = "Asset"
		child.Parent = model
		return model
	end,
}
SERVICES.SoundService = newInstance("Folder")
SERVICES.SoundService.Name = "SoundService"

game = newInstance("DataModel")
game.Name = "game"

workspace = newInstance("Workspace")
workspace.Name = "Workspace"
local camera = newInstance("Camera")
workspace.CurrentCamera = camera

setclipboard = function(text)
	clipboardValue = text
end

function __clipboard()
	return clipboardValue
end

function __settings()
	return settings
end

task = {
	wait = function() end,
	spawn = function(fn, ...)
		fn(...)
	end,
	delay = function() end,
}

typeof = function(value)
	return type(value)
end
warn = function(...)
	print("WARN", ...)
end
loadstring = load

__toolbarButton = newInstance("PluginToolbarButton")
local toolbar = {
	CreateButton = function()
		return __toolbarButton
	end,
}
local widget = newInstance("DockWidgetPluginGui")
plugin = {
	CreateToolbar = function()
		return toolbar
	end,
	CreateDockWidgetPluginGui = function()
		return widget
	end,
	GetSetting = function(_, key)
		return settings[key]
	end,
	SetSetting = function(_, key, value)
		settings[key] = value
	end,
}

-- ---------------------------------------------------------------- assertions

dofile("plugin/Golem.lua")

local function walk(node, out)
	for _, child in ipairs(node:GetChildren()) do
		table.insert(out, child)
		walk(child, out)
	end
	return out
end

local function all()
	return walk(widget, {})
end

local function findByText(text, className)
	for _, node in ipairs(all()) do
		if node.Text == text and (not className or node.ClassName == className) then
			return node
		end
	end
	return nil
end

local function findByPlaceholder(text)
	for _, node in ipairs(all()) do
		if node.ClassName == "TextBox" and node.PlaceholderText == text then
			return node
		end
	end
	return nil
end

local function ancestorPage(node)
	local current = node
	while current and current.ClassName ~= "ScrollingFrame" do
		current = current.Parent
	end
	return current
end

local function containsText(needle)
	for _, node in ipairs(all()) do
		if node.ClassName == "TextLabel" and type(node.Text) == "string" and string.find(node.Text, needle, 1, true) then
			return true
		end
	end
	return false
end

assert(widget.Enabled == true, "panel should open on first run")
assert(widget.Title == "Golem", "widget title")

local connectTab = findByText("Connect", "TextButton")
local consoleTab = findByText("Console", "TextButton")
local insertTab = findByText("Insert", "TextButton")
local skillsTab = findByText("Skills", "TextButton")
assert(connectTab and consoleTab and insertTab and skillsTab, "four tabs exist")

assert(findByText("npx golem-bridge connect", "TextLabel"), "connect command is shown")
assert(findByText("Copy command", "TextButton"), "copy button exists")

-- console tab
consoleTab.MouseButton1Click:Fire()
local codeBox = findByPlaceholder("print(game.Name)")
assert(codeBox, "console code box exists")
assert(ancestorPage(codeBox).Visible == true, "console page visible after tab click")

codeBox.Text = "print(1 + 1)"
findByText("Run", "TextButton").MouseButton1Click:Fire()
assert(containsText("2"), "print output captured")

codeBox.Text = "error('boom')"
findByText("Run", "TextButton").MouseButton1Click:Fire()
assert(containsText("boom"), "runtime error captured")

-- insert tab
insertTab.MouseButton1Click:Fire()
local idBox = findByPlaceholder("123456789")
assert(idBox, "asset id box exists")
idBox.Text = "rbxassetid://456"
assert(idBox.Text == "456", "non-digits are stripped from asset ids")

findByText("Image", "TextButton").MouseButton1Click:Fire()
findByText("Insert asset", "TextButton").MouseButton1Click:Fire()
local decals = 0
for _, node in ipairs(workspace:GetChildren()) do
	if node.ClassName == "Part" and node:FindFirstChildOfClass("Decal") then
		decals = decals + 1
	end
end
assert(decals == 1, "image insert creates a part with a decal")

findByText("Model", "TextButton").MouseButton1Click:Fire()
idBox.Text = "123"
local before = #workspace:GetChildren()
findByText("Insert asset", "TextButton").MouseButton1Click:Fire()
assert(#workspace:GetChildren() == before + 1, "model insert parents one asset")

findByText("Model", "TextButton").MouseButton1Click:Fire()
idBox.Text = "999"
findByText("Insert asset", "TextButton").MouseButton1Click:Fire()
assert(containsText("cannot be loaded"), "LoadAsset failure is reported")

-- skills tab
skillsTab.MouseButton1Click:Fire()
assert(containsText("rbx-unit-test"), "skills are listed")
findByText("Copy", "TextButton").MouseButton1Click:Fire()
assert(__clipboard() and string.find(__clipboard(), "rbx-create-skill", 1, true), "skill prompt copied")

assert(__settings()["Golem/Tab"] == "Skills", "tab choice is saved")

-- toolbar toggle and onboarding
local wasEnabled = widget.Enabled
__toolbarButton.Click:Fire()
assert(widget.Enabled == not wasEnabled, "toolbar toggles the panel")
__toolbarButton.Click:Fire()
assert(widget.Enabled == wasEnabled, "toolbar restores the panel")

findByText("?", "TextButton").MouseButton1Click:Fire()
assert(ancestorPage(codeBox).Visible == false, "hidden pages stay hidden")
assert(ancestorPage(findByText("npx golem-bridge connect", "TextLabel")).Visible == true, "help returns to connect")
assert(__settings()["Golem/Tab"] == "Connect", "help saves the connect tab")

findByText("Got it", "TextButton").MouseButton1Click:Fire()
assert(__settings()["Golem/Onboarded"] == true, "onboarding is remembered")
assert(__settings()["Golem/Open"] == true, "open state is saved")

for _, node in ipairs(all()) do
	local layouts = 0
	for _, child in ipairs(node:GetChildren()) do
		if child.ClassName == "UIListLayout" then
			layouts = layouts + 1
		end
	end
	assert(layouts <= 1, "more than one UIListLayout on " .. node.ClassName)
end

print("plugin smoke OK: " .. #all() .. " instances, console, insert, skills, tabs")
