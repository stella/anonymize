# stella DOCX core

Shared, bounded DOCX package extraction for the Node.js and Python document
adapters. The crate owns ZIP/XML validation, structural locations, UTF-16 text
segments, and fail-closed coverage inventory. It performs no filesystem or
network I/O; callers provide and receive bytes.

The TypeScript extractor remains temporarily as a fixture oracle while rewrite
logic moves into this crate. Cross-runtime tests require the Rust result to
match that oracle before an adapter is switched.
