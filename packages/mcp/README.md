# `@stll/anonymize-mcp`

Local, path-only MCP tools for stella anonymization. The server uses stdio only,
performs no network I/O, accepts no document text in tool arguments, and never
returns document text or plaintext session mappings.

Requires Node.js 20 or newer. This requirement applies to the MCP package only;
its native advisory-lock loader does not support Node.js 18.

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

- `capabilities` (public manifest and MCP metadata only)
- `anonymize_text_file`
- `anonymize_text_file_with_external_detections`
- `restore_text_file`
- `anonymize_docx_file`
- `restore_docx_file`
- `inspect_docx_file`

By default, sessions live only in the MCP server process. Restoration therefore
requires the same `sessionId` and the same running process that performed
anonymization. Stopping the server discards mappings.

## External detection sidecars

`anonymize_text_file_with_external_detections` merges native detections with a
provider-neutral `ExternalDetectionBatch` v1 JSON sidecar. The tool accepts only
an input `.txt` path, sidecar `.json` path, new output `.txt` path, `sessionId`,
and the same optional in-memory `language`; it never accepts or returns document
content, spans, mappings, or provider payloads. Both inputs must be inside the
configured roots. Text is capped at 64 MiB and the sidecar at 16 MiB.

A model-neutral local workflow is:

1. An application-owned fake or real provider reads the local text file.
2. It writes a closed-schema v1 sidecar containing the exact document SHA-256,
   one declared offset unit, explicit label mappings, and non-PII provenance
   IDs.
3. The MCP client calls the external-detection tool with paths only.
4. stella validates the digest/schema/offset boundaries, runs native detection,
   merges both sources through the normal session pipeline, and publishes only
   the anonymized file plus aggregate counts.

This package includes no GLiNER dependency or model runner. A fake provider is
enough for deterministic integration tests; any real provider remains outside
the MCP trust boundary. Stale digests, unknown fields, invalid boundaries,
unsafe paths, and oversized sidecars fail before output publication. In durable
mode the tool uses the full package and rejects `language`, exactly like the
ordinary text tool.

Failures from this tool cross the MCP boundary only as fixed audit-safe error
codes and messages. Parser, provider, label, document, path, native-plan, and
storage details are never copied into tool errors or logs.

## Encrypted durable sessions

Durable sessions are opt-in. Supply both an existing absolute private session
directory and an existing absolute private key file; supplying only one fails
startup:

```json
{
  "mcpServers": {
    "stella-anonymize": {
      "command": "npx",
      "args": [
        "-y",
        "@stll/anonymize-mcp",
        "--root",
        "/absolute/path/to/workspace",
        "--session-dir",
        "/absolute/private/path/to/sessions",
        "--key-file",
        "/absolute/private/path/to/session.key"
      ]
    }
  }
}
```

The key file format is exactly 32 raw bytes; text, hexadecimal, base64, and
password-derived keys are not accepted. The key file must be a regular,
owner-owned file with no group or other permissions. The session directory must
already exist, be owner-owned, grant no group or other permissions, and contain
no symbolic-link path components. Generate and protect the key outside the MCP
server; losing it makes archives unrecoverable, while disclosure permits anyone
with the archives to recover mappings.

Durable mode currently supports macOS and Linux only. Startup fails closed on
other platforms because the server requires POSIX owner identities,
`O_NOFOLLOW`, directory handles and `fsync`, plus process-lifetime advisory file
locks. One server exclusively locks the whole session directory; a second
server fails startup, and the operating system releases the lock if the holder
exits or crashes. The persistent `.stella-session.lock` file contains no session
metadata and is not itself proof that a live process holds the lock.

The server stores only bounded, authenticated encrypted session archives. It
never writes plaintext mappings or includes key material in tools, results, or
logs. Archive filenames are SHA-256 hashes of validated session IDs. Writes are
owner-only and atomically replace the preceding archive. The archive is made
durable before its corresponding output is published. If output publication or
rollback fails, the server preserves an authenticated archive and discards its
in-memory copy so a later operation reloads from disk; an unused forward mapping
is safer than erasing the last recoverable state. At most 256 archives
and 256 MiB of archive data are accepted. Restore authenticates the expected
session ID and evaluates lifecycle expiry at the current time. A wrong key,
tampered archive, expired session, unsafe path, partial write, or permission
change fails closed.

The encrypted core archive intentionally contains session state, not MCP
pipeline-selection metadata. To keep pipeline identity stable across restarts,
durable sessions always use the full all-language package and reject a
`language` argument. In-memory sessions retain the existing language-scoped
behavior. This avoids unauthenticated sidecar metadata and never guesses which
language package created an archive.

Transport closure, `SIGINT`, and `SIGTERM` stop new work, drain active
operations, close the durable store, release its advisory lock, and zero the
in-memory key before the process exits.

Tool results contain only aggregate, audit-safe counts and statuses. The
read-only `capabilities` tool returns `CAPABILITY_MANIFEST`, the native runtime
version, tool and format lists, stdio transport metadata, and either `memory` or
`durable-encrypted` session mode; it never returns document or session data.
