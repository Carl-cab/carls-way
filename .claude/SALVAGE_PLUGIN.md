# Salvage Project Plugin

This branch includes the **salvage** plugin, a Claude Code tool for project recovery and simplification.

## What is Salvage?

**Salvage** is used when a project has gone down a bad path:
- Wrong tech stack chosen
- Over-engineered for actual requirements
- Built on incomplete or outdated requirements

Instead of fighting existing code, salvage:
1. Recovers the *real* requirements (now that you know more)
2. Writes a portable spec to rebuild on the simplest maintainable stack
3. Produces a clean spec document (not code generation in the broken project)

## Using the Salvage Plugin

### Option 1: Via Claude Code CLI
```bash
# Clone if not already cloned
git clone --recurse-submodules https://github.com/Carl-cab/carls-way.git
cd carls-way

# Load the plugin for this session
claude --plugin-dir ./salvage-plugin
```

### Option 2: Automatic (Configured in Settings)
The plugin is configured in `.claude/settings.json` and should auto-load in Claude Code sessions.

## Plugin Location
- **Path**: `./salvage-plugin/`
- **Submodule Source**: `https://github.com/maludb/salvage-project.git`

## Documentation
For detailed information about salvage, see:
- `./salvage-plugin/README.md` — Full documentation
- `./salvage-plugin/docs/` — Additional guides

## When to Use Salvage

Salvage is ideal for:
- Projects that require a complete architectural rethink
- Codebases that are too complex for current requirements
- Situations where the tech stack isn't serving the real use case
- Requirements that have fundamentally changed since initial design

## Workflow Example

1. **Analyze** — Use salvage to understand what actually needs to exist
2. **Document** — Get a portable spec (no code yet)
3. **Plan** — Decide if rewrite is necessary or if refactoring suffices
4. **Rebuild** — Use the spec to implement in a fresh, simpler codebase
