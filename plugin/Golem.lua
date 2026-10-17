-- Golem - optional Studio panel.
--
-- Tool calls never pass through this plugin. Your AI talks straight to the
-- MCP server built into Roblox Studio; this panel is a control room that
-- shows the setup, runs Luau, inserts assets by id, and lists the skills.
--
-- Visual rules kept consistent on purpose: 12px card padding, 8px corners,
-- 1px borders, wrapped text with AutomaticSize (nothing clipped), one scroll
-- area per tab, and a fixed header/tab/footer so content never slides under.

local VERSION = "5.2.0"

local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local InsertService = game:GetService("InsertService")

local T = {
	bg = Color3.fromRGB(16, 17, 20),
	surface = Color3.fromRGB(23, 24, 29),
	elevated = Color3.fromRGB(30, 32, 39),
	input = Color3.fromRGB(12, 13, 16),
	border = Color3.fromRGB(42, 45, 54),
	text = Color3.fromRGB(242, 243, 245),
	muted = Color3.fromRGB(155, 161, 172),
	accent = Color3.fromRGB(76, 141, 255),
	accentHover = Color3.fromRGB(96, 156, 255),
	ok = Color3.fromRGB(61, 220, 132),
	warn = Color3.fromRGB(255, 176, 32),
	error = Color3.fromRGB(255, 92, 92),
}

local FONT = Enum.Font.Gotham
local FONT_MEDIUM = Enum.Font.GothamMedium
local FONT_BOLD = Enum.Font.GothamBold
local FONT_CODE = Enum.Font.Code

local SKILLS = {
	{
		name = "rbx-create-skill",
		desc = "Author, edit, or rename an Assistant skill.",
		prompt = "Use the rbx-create-skill skill to help me write a new Assistant skill for my game.",
	},
	{
		name = "rbx-debug",
		desc = "Breakpoints, call stacks, locals, and thread state.",
		prompt = "Use the rbx-debug skill to find and fix this bug: ",
	},
	{
		name = "rbx-device-simulator-lua",
		desc = "Device presets, orientation, and UI captures.",
		prompt = "Use the rbx-device-simulator-lua skill to check my UI on phone and tablet.",
	},
	{
		name = "rbx-docs-search",
		desc = "Authoritative Engine API and Creator documentation.",
		prompt = "Use the rbx-docs-search skill to confirm the right API for ",
	},
	{
		name = "rbx-perf-profiling",
		desc = "MicroProfiler traces and CPU, GPU, and memory hot spots.",
		prompt = "Use the rbx-perf-profiling skill to profile my place and show the biggest cost.",
	},
	{
		name = "rbx-scene-analysis",
		desc = "Render cost, memory, instance composition, and leaks.",
		prompt = "Use the rbx-scene-analysis skill to audit my place for render cost, memory, and leaks.",
	},
	{
		name = "rbx-unit-test",
		desc = "Jest-Lua or TestEZ detection, or a fallback harness.",
		prompt = "Use the rbx-unit-test skill to set up tests for my systems and run them.",
	},
}

local ASSET_TYPES = { "Model", "Image", "Audio", "Mesh", "Animation", "Package" }

-- ------------------------------------------------------------------ helpers

local function create(className, properties, children)
	local instance = Instance.new(className)
	for key, value in pairs(properties or {}) do
		instance[key] = value
	end
	for _, child in ipairs(children or {}) do
		child.Parent = instance
	end
	return instance
end

local function corner(instance, radius)
	create("UICorner", { CornerRadius = UDim.new(0, radius or 8), Parent = instance })
	return instance
end

local function stroke(instance, color, thickness)
	create("UIStroke", {
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
		Color = color or T.border,
		Thickness = thickness or 1,
		Parent = instance,
	})
	return instance
end

local function padding(instance, top, bottom, left, right)
	create("UIPadding", {
		PaddingTop = UDim.new(0, top),
		PaddingBottom = UDim.new(0, bottom),
		PaddingLeft = UDim.new(0, left),
		PaddingRight = UDim.new(0, right),
		Parent = instance,
	})
	return instance
end

local function column(instance, gap)
	create("UIListLayout", {
		Padding = UDim.new(0, gap or 8),
		SortOrder = Enum.SortOrder.LayoutOrder,
		Parent = instance,
	})
	return instance
end

local function row(instance, gap)
	create("UIListLayout", {
		FillDirection = Enum.FillDirection.Horizontal,
		Padding = UDim.new(0, gap or 8),
		SortOrder = Enum.SortOrder.LayoutOrder,
		VerticalAlignment = Enum.VerticalAlignment.Center,
		Parent = instance,
	})
	return instance
end

local function textLabel(text, size, color, bold, wrapped)
	return create("TextLabel", {
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Font = bold and FONT_BOLD or FONT,
		Text = text,
		TextSize = size or 12,
		TextColor3 = color or T.text,
		TextWrapped = wrapped ~= false,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Top,
	})
end

local function sectionTitle(text)
	return textLabel(text, 13, T.text, true)
end

local function body(text, color)
	return textLabel(text, 12, color or T.muted)
end

local function card(height)
	local frame = create("Frame", {
		BackgroundColor3 = T.surface,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, height or 0),
		AutomaticSize = height and Enum.AutomaticSize.None or Enum.AutomaticSize.Y,
	})
	corner(frame)
	stroke(frame)
	column(frame, 8)
	padding(frame, 12, 12, 12, 12)
	return frame
end

local function setText(instance, text)
	if instance and instance.Parent then
		instance.Text = text
	end
end

-- ------------------------------------------------------------------ chrome

local function makeButton(text, variant)
	local palette
	if variant == "primary" then
		palette = { base = T.accent, hover = T.accentHover, text = Color3.fromRGB(255, 255, 255), border = nil }
	elseif variant == "quiet" then
		palette = { base = T.bg, hover = T.elevated, text = T.muted, border = nil }
	else
		palette = { base = T.elevated, hover = T.border, text = T.text, border = T.border }
	end

	local button = create("TextButton", {
		BackgroundColor3 = palette.base,
		BorderSizePixel = 0,
		Font = FONT_MEDIUM,
		Text = text,
		TextSize = 12,
		TextColor3 = palette.text,
		AutoButtonColor = false,
	})
	corner(button, 6)
	if palette.border then
		stroke(button, palette.border)
	end

	button.MouseEnter:Connect(function()
		if not button:GetAttribute("golemActive") then
			button.BackgroundColor3 = palette.hover
		end
	end)
	button.MouseLeave:Connect(function()
		if not button:GetAttribute("golemActive") then
			button.BackgroundColor3 = palette.base
		end
	end)
	return button
end

local function codeBlock(command)
	local frame = create("Frame", {
		BackgroundColor3 = T.input,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 96),
	})
	corner(frame)
	stroke(frame)
	padding(frame, 10, 10, 10, 10)

	create("TextLabel", {
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 0, 0, 0),
		Size = UDim2.new(1, 0, 0, 14),
		Font = FONT,
		Text = "Run this in your terminal",
		TextSize = 10,
		TextColor3 = T.muted,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = frame,
	})

	create("TextLabel", {
		BackgroundTransparency = 1,
		Position = UDim2.new(0, 0, 0, 16),
		Size = UDim2.new(1, 0, 0, 18),
		Font = FONT_CODE,
		Text = command,
		TextSize = 12,
		TextColor3 = T.text,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Parent = frame,
	})
	return frame
end

-- ------------------------------------------------------------------ plugin ui

local toolbar = plugin:CreateToolbar("Golem")
local toolbarButton = toolbar:CreateButton(
	"Golem",
	"Open the Golem panel",
	"rbxasset://textures/ui/GuiImagePlaceholder.png"
)

local info = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	true,
	false,
	360,
	640,
	300,
	420
)
local widget = plugin:CreateDockWidgetPluginGui("GolemPanel", info)
widget.Title = "Golem"

local function getSetting(key, default)
	local ok, value = pcall(function()
		return plugin:GetSetting(key)
	end)
	if ok and value ~= nil then
		return value
	end
	return default
end

local function putSetting(key, value)
	pcall(function()
		plugin:SetSetting(key, value)
	end)
end

local root = create("Frame", {
	BackgroundColor3 = T.bg,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 1, 0),
})
root.Parent = widget

local header = create("Frame", {
	BackgroundColor3 = T.bg,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 0, 54),
})
header.Parent = root

local logo = create("Frame", {
	BackgroundColor3 = T.accent,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 14, 0, 13),
	Size = UDim2.new(0, 28, 0, 28),
})
corner(logo, 8)
logo.Parent = header
create("TextLabel", {
	BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 1, 0),
	Font = FONT_BOLD,
	Text = "G",
	TextSize = 15,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	Parent = logo,
})

local title = create("TextLabel", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 52, 0, 9),
	Size = UDim2.new(1, -100, 0, 18),
	Font = FONT_BOLD,
	Text = "Golem",
	TextSize = 15,
	TextColor3 = T.text,
	TextXAlignment = Enum.TextXAlignment.Left,
	Parent = header,
})

local subtitle = create("TextLabel", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 52, 0, 27),
	Size = UDim2.new(1, -100, 0, 14),
	Font = FONT,
	Text = "Roblox Studio tools",
	TextSize = 11,
	TextColor3 = T.muted,
	TextXAlignment = Enum.TextXAlignment.Left,
	Parent = header,
})

local helpButton = makeButton("?", "quiet")
helpButton.Size = UDim2.new(0, 24, 0, 24)
helpButton.Position = UDim2.new(1, -38, 0, 15)
helpButton.TextSize = 13
helpButton.Parent = header

local tabBar = create("Frame", {
	BackgroundColor3 = T.bg,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 0, 0, 54),
	Size = UDim2.new(1, 0, 0, 36),
})
tabBar.Parent = root

local footer = create("Frame", {
	BackgroundColor3 = T.surface,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 0, 1, -30),
	Size = UDim2.new(1, 0, 0, 30),
})
footer.Parent = root
create("Frame", {
	BackgroundColor3 = T.border,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 0, 1),
	Parent = footer,
})

create("TextLabel", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 8),
	Size = UDim2.new(0, 120, 0, 14),
	Font = FONT,
	Text = "Golem " .. VERSION,
	TextSize = 10,
	TextColor3 = T.muted,
	TextXAlignment = Enum.TextXAlignment.Left,
	Parent = footer,
})

local statusLabel = create("TextLabel", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 140, 0, 7),
	Size = UDim2.new(1, -154, 0, 16),
	Font = FONT_MEDIUM,
	Text = "Studio MCP",
	TextSize = 10,
	TextColor3 = T.muted,
	TextXAlignment = Enum.TextXAlignment.Right,
	TextTruncate = Enum.TextTruncate.AtEnd,
	Parent = footer,
})

local function setStatus(message, kind)
	if not statusLabel or not statusLabel.Parent then
		return
	end
	statusLabel.Text = message
	if kind == "ok" then
		statusLabel.TextColor3 = T.ok
	elseif kind == "warn" then
		statusLabel.TextColor3 = T.warn
	elseif kind == "error" then
		statusLabel.TextColor3 = T.error
	else
		statusLabel.TextColor3 = T.muted
	end
end

local content = create("Frame", {
	BackgroundTransparency = 1,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 0, 0, 90),
	Size = UDim2.new(1, 0, 1, -120),
	ClipsDescendants = true,
})
content.Parent = root

local function newPage()
	local page = create("ScrollingFrame", {
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 1, 0),
		CanvasSize = UDim2.new(0, 0, 0, 0),
		AutomaticCanvasSize = Enum.AutomaticSize.Y,
		ScrollBarThickness = 4,
		ScrollBarImageColor3 = T.border,
		ScrollingDirection = Enum.ScrollingDirection.Y,
		Visible = false,
	})
	column(page, 12)
	padding(page, 14, 16, 14, 14)
	page.Parent = content
	return page
end

local pages = {
	Connect = newPage(),
	Console = newPage(),
	Insert = newPage(),
	Skills = newPage(),
}
local tabOrder = { "Connect", "Console", "Insert", "Skills" }
local tabButtons = {}
local tabIndicators = {}

local activeTab = "Connect"

local function selectTab(name)
	if not pages[name] then
		name = "Connect"
	end
	activeTab = name
	putSetting("Golem/Tab", name)
	for tabName, page in pairs(pages) do
		page.Visible = tabName == name
	end
	for tabName, button in pairs(tabButtons) do
		local active = tabName == name
		button:SetAttribute("golemActive", active)
		button.TextColor3 = active and T.text or T.muted
		button.BackgroundColor3 = active and T.elevated or T.bg
		local indicator = tabIndicators[tabName]
		if indicator then
			indicator.Visible = active
		end
	end
end

for index, name in ipairs(tabOrder) do
	local tab = makeButton(name, "quiet")
	tab.Size = UDim2.new(0.25, 0, 1, 0)
	tab.Position = UDim2.new((index - 1) * 0.25, 0, 0, 0)
	tab.TextSize = 11
	tab.Parent = tabBar
	tab.MouseButton1Click:Connect(function()
		selectTab(name)
	end)
	local indicator = create("Frame", {
		BackgroundColor3 = T.accent,
		BorderSizePixel = 0,
		Position = UDim2.new(0, 8, 1, -2),
		Size = UDim2.new(1, -16, 0, 2),
		Visible = false,
		Parent = tab,
	})
	corner(indicator, 1)
	tabIndicators[name] = indicator
	tabButtons[name] = tab
end

helpButton.MouseButton1Click:Connect(function()
	selectTab("Connect")
end)

-- ------------------------------------------------------------------ connect

local connectPage = pages.Connect

local onboard = card()
onboard.LayoutOrder = 1
onboard.Parent = connectPage
local onboardStroke = onboard:FindFirstChildOfClass("UIStroke")
if onboardStroke then
	onboardStroke.Color = T.accent
	onboardStroke.Transparency = 0.55
end
create("TextLabel", {
	BackgroundColor3 = T.accent,
	BorderSizePixel = 0,
	Size = UDim2.new(0, 44, 0, 16),
	Font = FONT_BOLD,
	Text = "START",
	TextSize = 9,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	Parent = onboard,
})
local onboardTag = onboard:FindFirstChildOfClass("TextLabel")
corner(onboardTag, 4)

local onboardTitle = textLabel("Three steps to connect", 13, T.text, true)
onboardTitle.Parent = onboard

local onboardBody = body("This panel shows the setup and runs Luau. Your AI talks straight to Studio's MCP server, not through the plugin.")
onboardBody.Parent = onboard

local dismiss = makeButton("Got it", "primary")
dismiss.Size = UDim2.new(0, 76, 0, 26)
dismiss.Parent = onboard
dismiss.MouseButton1Click:Connect(function()
	putSetting("Golem/Onboarded", true)
	onboard.Visible = false
end)

local connectTitle = sectionTitle("Connect your AI")
connectTitle.LayoutOrder = 2
connectTitle.Parent = connectPage

local connectBody = body("Golem uses the MCP server built into Roblox Studio. Nothing is relayed, installed into the place, or saved between commands.")
connectBody.LayoutOrder = 3
connectBody.Parent = connectPage

local steps = card()
steps.LayoutOrder = 4
steps.Parent = connectPage

local function stepRow(number, text)
	local frame = create("Frame", {
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
	})
	create("UIListLayout", {
		Padding = UDim.new(0, 8),
		FillDirection = Enum.FillDirection.Horizontal,
		VerticalAlignment = Enum.VerticalAlignment.Top,
		Parent = frame,
	})
	local chip = create("Frame", {
		BackgroundColor3 = T.elevated,
		BorderSizePixel = 0,
		Size = UDim2.new(0, 20, 0, 20),
	})
	corner(chip, 10)
	create("TextLabel", {
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 1, 0),
		Font = FONT_BOLD,
		Text = tostring(number),
		TextSize = 10,
		TextColor3 = T.text,
		Parent = chip,
	})
	chip.Parent = frame
	local label = textLabel(text, 12, T.text)
	label.Size = UDim2.new(1, -32, 0, 0)
	label.Parent = frame
	return frame
end

stepRow(1, "Open Assistant, then ... then Manage MCP Servers (older Studio: Settings, MCP Servers).").Parent = steps
stepRow(2, "Turn on Enable Studio as MCP server. The green dot means a client is attached.").Parent = steps
stepRow(3, "Run the command below in a terminal. It prints the tool manual for your AI.").Parent = steps

local command = codeBlock("npx golem-bridge connect")
command.LayoutOrder = 5
command.Parent = connectPage

local copyConnect = makeButton("Copy command", "primary")
copyConnect.Size = UDim2.new(0, 108, 0, 26)
copyConnect.Position = UDim2.new(0, 0, 0, 42)
copyConnect.Parent = command

local manualHint = body("Already connected? npx golem-bridge status checks the link, and npx golem-bridge tools prints every tool Studio offers.")
manualHint.LayoutOrder = 6
manualHint.Parent = connectPage

local panelNote = card()
panelNote.LayoutOrder = 7
panelNote.Parent = connectPage
local noteTitle = textLabel("What this panel does", 12, T.text, true)
noteTitle.Parent = panelNote
local noteBody = textLabel("Luau console, insert by asset id, and the skill list. Search and every other tool stay in the AI, where the MCP server lives.", 11, T.muted)
noteBody.Parent = panelNote

onboard.Visible = getSetting("Golem/Onboarded", false) ~= true

-- clipboard

local function copyToClipboard(text, label)
	if type(setclipboard) ~= "function" then
		setStatus("Clipboard is unavailable here", "warn")
		return
	end
	local ok = pcall(setclipboard, text)
	if ok then
		setStatus(label or "Copied", "ok")
	else
		setStatus("Could not copy", "error")
	end
end

copyConnect.MouseButton1Click:Connect(function()
	copyToClipboard("npx golem-bridge connect", "Connect command copied")
end)

-- ------------------------------------------------------------------ console

local consolePage = pages.Console

local consoleHeader = create("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 0, 20),
})
consoleHeader.Parent = consolePage
row(consoleHeader, 6)

local consoleTitle = textLabel("Luau console", 13, T.text, true)
consoleTitle.Size = UDim2.new(1, -70, 0, 18)
consoleTitle.Parent = consoleHeader

local editPill = create("TextLabel", {
	BackgroundColor3 = T.elevated,
	BorderSizePixel = 0,
	Size = UDim2.new(0, 56, 0, 18),
	Font = FONT_MEDIUM,
	Text = "Edit",
	TextSize = 10,
	TextColor3 = T.muted,
})
corner(editPill, 9)
editPill.Parent = consoleHeader

local consoleBody = body("Same datamodel as the command bar. print and warn are captured below while this runs.")
consoleBody.Parent = consolePage

local codeFrame = create("Frame", {
	BackgroundColor3 = T.input,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 0, 132),
})
corner(codeFrame)
stroke(codeFrame)
padding(codeFrame, 8, 8, 8, 8)
codeFrame.Parent = consolePage

local codeBox = create("TextBox", {
	BackgroundTransparency = 1,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 1, 0),
	Font = FONT_CODE,
	Text = "",
	TextSize = 12,
	TextColor3 = T.text,
	PlaceholderText = "print(game.Name)",
	PlaceholderColor3 = T.muted,
	TextWrapped = false,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	ClearTextOnFocus = false,
	MultiLine = true,
	Parent = codeFrame,
})

local consoleButtons = create("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 0, 30),
})
row(consoleButtons, 8)
consoleButtons.Parent = consolePage

local runButton = makeButton("Run", "primary")
runButton.Size = UDim2.new(0, 88, 1, 0)
runButton.Parent = consoleButtons

local clearButton = makeButton("Clear", "ghost")
clearButton.Size = UDim2.new(0, 68, 1, 0)
clearButton.Parent = consoleButtons

local runHint = textLabel("print() is captured", 10, T.muted)
runHint.TextXAlignment = Enum.TextXAlignment.Right
runHint.Size = UDim2.new(1, -170, 1, 0)
runHint.TextYAlignment = Enum.TextYAlignment.Center
runHint.Parent = consoleButtons

local outputHeader = create("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 0, 16),
})
outputHeader.Parent = consolePage
create("TextLabel", {
	BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 1, 0),
	Font = FONT_MEDIUM,
	Text = "Output",
	TextSize = 11,
	TextColor3 = T.muted,
	TextXAlignment = Enum.TextXAlignment.Left,
	Parent = outputHeader,
})

local outputFrame = create("Frame", {
	BackgroundColor3 = T.input,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 0, 210),
})
corner(outputFrame)
stroke(outputFrame)
padding(outputFrame, 9, 9, 9, 9)
outputFrame.Parent = consolePage

local outputScroll = create("ScrollingFrame", {
	BackgroundTransparency = 1,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 1, 0),
	CanvasSize = UDim2.new(0, 0, 0, 0),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	ScrollBarThickness = 4,
	ScrollBarImageColor3 = T.border,
	ScrollingDirection = Enum.ScrollingDirection.Y,
	Parent = outputFrame,
})
column(outputScroll, 4)

local emptyOutput = textLabel("Nothing yet. Run a line of Luau.", 11, T.muted)
emptyOutput.Parent = outputScroll

local outputLines = {}

local function appendOutput(kind, text)
	if emptyOutput and emptyOutput.Parent then
		emptyOutput:Destroy()
		emptyOutput = nil
	end
	local color = T.text
	if kind == "warn" then
		color = T.warn
	elseif kind == "error" then
		color = T.error
	elseif kind == "ok" then
		color = T.ok
	end
	local line = create("TextLabel", {
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Font = FONT_CODE,
		Text = text,
		TextSize = 11,
		TextColor3 = color,
		TextWrapped = true,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Top,
		Parent = outputScroll,
	})
	table.insert(outputLines, line)
	while #outputLines > 200 do
		local oldest = table.remove(outputLines, 1)
		if oldest then
			oldest:Destroy()
		end
	end
end

local function stringify(value)
	if type(value) == "table" then
		local parts = {}
		local count = 0
		for key, item in pairs(value) do
			count = count + 1
			if count > 12 then
				parts[#parts + 1] = "..."
				break
			end
			parts[#parts + 1] = tostring(key) .. "=" .. tostring(item)
		end
		return "{" .. table.concat(parts, ", ") .. "}"
	end
	return tostring(value)
end

local function joinArgs(...)
	local parts = {}
	for index = 1, select("#", ...) do
		parts[#parts + 1] = stringify((select(index, ...)))
	end
	return table.concat(parts, " ")
end

local function beginRecording(name)
	local hasRecording = pcall(function()
		return ChangeHistoryService.TryBeginRecording
	end)
	if hasRecording then
		local ok, recording = pcall(function()
			return ChangeHistoryService:TryBeginRecording(name)
		end)
		if ok then
			return recording
		end
	end
	pcall(function()
		service:SetWaypoint(name)
	end)
	return nil
end

local function finishRecording(recording, name)
	if recording then
		pcall(function()
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end)
	else
		pcall(function()
			ChangeHistoryService:SetWaypoint(name)
		end)
	end
end

local function runCode()
	local source = codeBox.Text
	if source:gsub("%s", "") == "" then
		setStatus("Nothing to run", "warn")
		return
	end
	if type(loadstring) ~= "function" then
		setStatus("loadstring is unavailable in this Studio build", "error")
		return
	end

	local chunk, compileError = loadstring(source, "GolemConsole")
	if not chunk then
		appendOutput("error", tostring(compileError))
		setStatus("Compile error", "error")
		return
	end

	local oldPrint, oldWarn = print, warn
	print = function(...)
		appendOutput("log", joinArgs(...))
		oldPrint(...)
	end
	warn = function(...)
		appendOutput("warn", joinArgs(...))
		oldWarn(...)
	end

	local recording = beginRecording("Golem Console")
	local ok, result = pcall(chunk)
	finishRecording(recording, "Golem Console")

	print = oldPrint
	warn = oldWarn

	if ok then
		if result ~= nil then
			appendOutput("ok", "returned " .. stringify(result))
		end
		setStatus("Ran successfully", "ok")
	else
		appendOutput("error", tostring(result))
		setStatus("Error - see output", "error")
	end
end

runButton.MouseButton1Click:Connect(runCode)

clearButton.MouseButton1Click:Connect(function()
	for _, line in ipairs(outputLines) do
		if line and line.Parent then
			line:Destroy()
		end
	end
	outputLines = {}
	if not (emptyOutput and emptyOutput.Parent) then
		emptyOutput = textLabel("Nothing yet. Run a line of Luau.", 11, T.muted)
		emptyOutput.Parent = outputScroll
	end
	setStatus("Output cleared", "muted")
end)

-- ------------------------------------------------------------------ insert

local insertPage = pages.Insert

local insertTitle = textLabel("Insert an asset", 13, T.text, true)
insertTitle.Parent = insertPage

local insertBody = body("Models, images, audio, meshes, animations, and packages. Use the AI's golem-bridge search to find ids across every marketplace kind.")
insertBody.Parent = insertPage

local typeCard = card()
typeCard.Parent = insertPage

local typeLabel = textLabel("Asset type", 11, T.muted)
typeLabel.Parent = typeCard

local typeRows = {
	create("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 26) }),
	create("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 26) }),
}
for _, typeRowFrame in ipairs(typeRows) do
	row(typeRowFrame, 6)
	typeRowFrame.Parent = typeCard
end

local selectedType = "Model"
local typeButtons = {}

local function refreshTypeButtons()
	for name, button in pairs(typeButtons) do
		local active = name == selectedType
		button:SetAttribute("golemActive", active)
		button.BackgroundColor3 = active and T.accent or T.elevated
		button.TextColor3 = active and Color3.fromRGB(255, 255, 255) or T.text
	end
end

for index, name in ipairs(ASSET_TYPES) do
	local button = makeButton(name, "ghost")
	button.Size = UDim2.new(1 / 3, -4, 1, 0)
	button.TextSize = 11
	button.Parent = typeRows[(index <= 3) and 1 or 2]
	button.MouseButton1Click:Connect(function()
		selectedType = name
		refreshTypeButtons()
		setStatus(name .. " selected", "muted")
	end)
	typeButtons[name] = button
end
refreshTypeButtons()

local idLabel = textLabel("Asset id", 11, T.muted)
idLabel.Parent = insertPage

local idFrame = create("Frame", {
	BackgroundColor3 = T.input,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 0, 32),
})
corner(idFrame)
stroke(idFrame)
padding(idFrame, 0, 0, 10, 10)
idFrame.Parent = insertPage

local idBox = create("TextBox", {
	BackgroundTransparency = 1,
	BorderSizePixel = 0,
	Size = UDim2.new(1, 0, 1, 0),
	Font = FONT_CODE,
	Text = "",
	TextSize = 12,
	TextColor3 = T.text,
	PlaceholderText = "123456789",
	PlaceholderColor3 = T.muted,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Center,
	ClearTextOnFocus = false,
	Parent = idFrame,
})

idBox:GetPropertyChangedSignal("Text"):Connect(function()
	local digits = idBox.Text:gsub("%D", "")
	if digits ~= idBox.Text then
		idBox.Text = digits
	end
end)

local destinationLabel = textLabel("Destination: Workspace", 11, T.muted)
destinationLabel.Parent = insertPage

local function selectedInstance()
	local selection = Selection:Get()
	return selection[1]
end

local function destinationForInsert()
	local selected = selectedInstance()
	if selected then
		if selected:IsA("BasePart") then
			return selected.Parent or workspace
		end
		if selected:IsA("Model") or selected:IsA("Folder") or selected:IsA("Workspace") then
			return selected
		end
	end
	return workspace
end

local function refreshDestination()
	local selected = selectedInstance()
	if selected then
		destinationLabel.Text = "Destination: " .. selected:GetFullName()
	else
		destinationLabel.Text = "Destination: Workspace"
	end
end

Selection.SelectionChanged:Connect(refreshDestination)
refreshDestination()

local insertButton = makeButton("Insert asset", "primary")
insertButton.Size = UDim2.new(1, 0, 0, 34)
insertButton.Parent = insertPage

local insertHint = body("InsertService only loads free or owned models and packages. Images, audio, meshes, and animations are created from their id.")
insertHint.Parent = insertPage

local function cameraSpot()
	local camera = workspace.CurrentCamera
	if camera then
		return camera.CFrame * CFrame.new(0, 0, -10)
	end
	return CFrame.new(0, 5, 0)
end

local function ensurePart()
	local selected = selectedInstance()
	if selected and selected:IsA("BasePart") then
		return selected
	end
	local part = Instance.new("Part")
	part.Size = Vector3.new(4, 4, 0.2)
	part.Anchored = true
	part.CFrame = cameraSpot()
	part.Parent = workspace
	return part
end

local function insertAsset(assetId)
	local destination = destinationForInsert()
	local recording = beginRecording("Golem Insert")

	if selectedType == "Model" or selectedType == "Package" then
		local ok, loaded = pcall(function()
			return InsertService:LoadAsset(assetId)
		end)
		if not ok or not loaded then
			finishRecording(recording, "Golem Insert")
			setStatus("That asset cannot be loaded here", "error")
			return
		end
		local children = loaded:GetChildren()
		local asset = children[1]
		loaded.Name = "GolemAsset"
		if #children == 1 and asset then
			asset.Parent = destination
			loaded:Destroy()
		else
			loaded.Parent = destination
		end
		finishRecording(recording, "Golem Insert")
		setStatus("Inserted " .. tostring(assetId), "ok")
		return
	end

	if selectedType == "Image" then
		local part = ensurePart()
		local decal = Instance.new("Decal")
		decal.Texture = "rbxassetid://" .. tostring(assetId)
		decal.Face = Enum.NormalId.Front
		decal.Parent = part
		finishRecording(recording, "Golem Insert")
		setStatus("Added image to " .. part:GetFullName(), "ok")
		return
	end

	if selectedType == "Audio" then
		local sound = Instance.new("Sound")
		sound.SoundId = "rbxassetid://" .. tostring(assetId)
		sound.Name = "GolemSound"
		sound.Parent = game:GetService("SoundService")
		finishRecording(recording, "Golem Insert")
		setStatus("Added sound to SoundService", "ok")
		return
	end

	if selectedType == "Animation" then
		local animation = Instance.new("Animation")
		animation.AnimationId = "rbxassetid://" .. tostring(assetId)
		animation.Name = "GolemAnimation"
		local selected = selectedInstance()
		if selected and (selected:IsA("Animator") or selected:IsA("Humanoid")) then
			animation.Parent = selected
		else
			animation.Parent = workspace
		end
		finishRecording(recording, "Golem Insert")
		setStatus("Animation added to " .. animation.Parent:GetFullName(), "ok")
		return
	end

	if selectedType == "Mesh" then
		local part = ensurePart()
		local mesh = Instance.new("SpecialMesh")
		mesh.MeshId = "rbxassetid://" .. tostring(assetId)
		mesh.Parent = part
		finishRecording(recording, "Golem Insert")
		setStatus("Added mesh to " .. part:GetFullName(), "ok")
		return
	end

	finishRecording(recording, "Golem Insert")
	setStatus("Unknown asset type", "error")
end

insertButton.MouseButton1Click:Connect(function()
	local id = tonumber(idBox.Text)
	if not id or id <= 0 then
		setStatus("Enter a numeric asset id", "warn")
		return
	end
	local ok, err = pcall(insertAsset, id)
	if not ok then
		setStatus("Insert failed: " .. tostring(err), "error")
	end
end)

-- ------------------------------------------------------------------ skills

local skillsPage = pages.Skills

local skillsHeader = create("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.new(1, 0, 0, 20),
})
skillsHeader.Parent = skillsPage
create("UIListLayout", {
	FillDirection = Enum.FillDirection.Horizontal,
	Padding = UDim.new(0, 6),
	SortOrder = Enum.SortOrder.LayoutOrder,
	VerticalAlignment = Enum.VerticalAlignment.Center,
	Parent = skillsHeader,
})

create("TextLabel", {
	BackgroundTransparency = 1,
	Size = UDim2.new(0, 132, 0, 18),
	Font = FONT_BOLD,
	Text = "Roblox skills",
	TextSize = 13,
	TextColor3 = T.text,
	TextXAlignment = Enum.TextXAlignment.Left,
	Parent = skillsHeader,
})

local countPill = create("TextLabel", {
	BackgroundColor3 = T.elevated,
	BorderSizePixel = 0,
	Size = UDim2.new(0, 22, 0, 16),
	Font = FONT_MEDIUM,
	Text = tostring(#SKILLS),
	TextSize = 10,
	TextColor3 = T.muted,
})
corner(countPill, 8)
countPill.Parent = skillsHeader

local skillsBody = body("Served by Studio's Assistant and loaded through MCP. Copy a prompt for your AI; the plugin does not run skills.")
skillsBody.Parent = skillsPage

for _, skill in ipairs(SKILLS) do
	local skillCard = card()
	skillCard.Parent = skillsPage

	local topRow = create("Frame", {
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 20),
	})
	topRow.Parent = skillCard

	local nameLabel = create("TextLabel", {
		BackgroundTransparency = 1,
		Size = UDim2.new(1, -62, 1, 0),
		Font = FONT_CODE,
		Text = skill.name,
		TextSize = 11,
		TextColor3 = T.accent,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Parent = topRow,
	})

	local copyPrompt = makeButton("Copy", "ghost")
	copyPrompt.Size = UDim2.new(0, 54, 0, 20)
	copyPrompt.Position = UDim2.new(1, -54, 0, 0)
	copyPrompt.TextSize = 10
	copyPrompt.Parent = topRow
	copyPrompt.MouseButton1Click:Connect(function()
		copyToClipboard(skill.prompt, "Prompt copied")
	end)

	local descLabel = textLabel(skill.desc, 11, T.muted)
	descLabel.Parent = skillCard
end

-- ------------------------------------------------------------------ boot

local savedTab = getSetting("Golem/Tab", "Connect")
selectTab(savedTab)

local openSetting = getSetting("Golem/Open", true)
widget.Enabled = openSetting ~= false
if not getSetting("Golem/Onboarded", false) then
	widget.Enabled = true
end

toolbarButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
	putSetting("Golem/Open", widget.Enabled)
end)

widget:GetPropertyChangedSignal("Enabled"):Connect(function()
	putSetting("Golem/Open", widget.Enabled)
end)

widget:BindToClose(function()
	putSetting("Golem/Open", widget.Enabled)
end)

setStatus("Studio MCP", "muted")
