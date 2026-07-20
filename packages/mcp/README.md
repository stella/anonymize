# `@stll/anonymize-mcp`

Local, path-only MCP tools for stella anonymization. The server uses stdio only,
performs no network I/O, accepts no document text in tool arguments, and never
returns document text or plaintext session mappings.

```json
{
  "mcpServers": {
    "stella-anonymize": {
      "command": "npx",
      "args": [
        "-y",
        "@stll/anonymize-mcp",
        "--root",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

Repeat `--root` to allow more than one directory. Inputs and outputs must be
absolute paths within those roots. Outputs must be explicit new paths; the
server refuses overwrites and writes with owner-only permissions. Text must be
valid UTF-8; text and DOCX inputs are limited to 64 MiB. A server process holds
at most 256 in-memory sessions.

Tools:

- `anonymize_text_file`
- `restore_text_file`
- `anonymize_docx_file`
- `restore_docx_file`
- `inspect_docx_file`

Sessions live only in the MCP server process. Restoration therefore requires
the same `sessionId` and the same running process that performed anonymization.
Stopping the server discards mappings. Tool results contain only aggregate,
audit-safe counts and statuses.
