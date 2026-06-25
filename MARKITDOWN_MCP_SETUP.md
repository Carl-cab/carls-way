# Markitdown MCP Server Setup

This project is configured to use the [markitdown-mcp](https://github.com/trsdn/markitdown-mcp) MCP (Model Context Protocol) server, which provides tools for converting various file formats to Markdown.

## Installation

### Prerequisites
- Python 3.x
- `pipx` (for installing Python CLI applications)

### Local Setup

To install and enable markitdown-mcp on your local machine:

```bash
# Install the markitdown-mcp server via pipx
pipx install git+https://github.com/trsdn/markitdown-mcp.git

# Inject the full markitdown package with all dependencies
pipx inject markitdown-mcp 'markitdown[all]'
```

Once installed, Claude Code will automatically discover and use the MCP server via the configuration in `.claude/settings.json`.

## Configuration

The `.claude/settings.json` file already contains the necessary MCP server configuration:

```json
{
  "mcpServers": {
    "markitdown": {
      "command": "pipx",
      "args": ["run", "markitdown-mcp"]
    }
  }
}
```

## Usage

Once installed, Claude Code will have access to markitdown-mcp tools for:
- Converting PDF, Word documents, and other formats to Markdown
- Processing multiple files at once
- Preserving formatting and structure during conversion

## Documentation

For more information about markitdown-mcp, visit:
- Repository: https://github.com/trsdn/markitdown-mcp
- Markitdown docs: https://github.com/microsoft/markitdown
