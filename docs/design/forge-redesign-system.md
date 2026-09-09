# Forge desktop structural redesign system

## Product character

Forge should feel like a focused Windows coding workbench: calm, precise, fast, and technical without looking cramped. The conversation is the primary surface. Navigation, tool activity, code changes, terminal output, and extension management support that surface instead of competing with it.

## Layout

- Navigation cockpit: 264 px, graphite, full height. Brand, project, branch, runtime state, tasks, and settings live in one continuous rail.
- Workspace toolbar: 58 px, white, spanning only the conversation and inspector. There is no global dark top bar.
- Conversation: a flexible mist-gray canvas with an 820 px reading and composer width. User requests align right in pale blue; Forge results align left without cards or a timeline connector.
- Inspector: 380 px on wide screens; becomes a closable overlay below 1180 px.
- Settings: fills the workspace to the right of the navigation cockpit. Its 214 px dark secondary navigation is persistent and content scrolls independently.
- Marketplace: open table-like rows on wide screens, switching to compact stacked rows only when the workspace is narrow.

## Tokens

- Background: `#f4f6f8`
- Subtle surface: `#f5f7f9`
- Raised surface: `#ffffff`
- Navigation: `#171a20`
- Primary text: `#17191e`
- Secondary text: `#666c77`
- Hairline: `#e2e5ea`
- Strong border: `#cdd2da`
- Accent: `#4f6bff`
- Success: `#218553`
- Danger: `#c2414b`
- Warning: `#a46612`
- Main radius: 8 px; settings has no floating-dialog radius.
- Body type: 13 px minimum; conversation text: 14 px; headings: 18–22 px.

## Interaction rules

- One task turn renders one user request, one final Forge result, and one collapsed process row.
- Tool calls, commands, and individual file writes stay inside the expandable process area.
- Do not use a message card or connector line for the final Forge result.
- Use blue only for selection and primary action; use status colors only for status meaning.
- All interactive controls must have hover, disabled, and keyboard-focus states.
- At 1000 x 700 the inspector must remain reachable without compressing the conversation below a useful width.
- Motion is limited to short state transitions and is disabled for reduced-motion users.
