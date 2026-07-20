# stella DOCX core

Shared, bounded DOCX package extraction and rewriting for the Node.js and
Python document adapters. The crate owns ZIP/XML validation, structural
locations, UTF-16 text segments, fail-closed coverage inventory, transactional
rewrite validation, and archive reconstruction. It performs no filesystem or
network I/O; callers provide and receive bytes.

Both runtime adapters are intentionally thin. Behavioral tests exercise the
same Rust contract through Node.js and Python, while direct crate tests pin the
security-sensitive rewrite invariants.
