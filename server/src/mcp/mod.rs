//! DWEEB's remote MCP server.
//!
//! See `docs/mcp.md`. This module is the Rust half: the Components V2 schema
//! (`components`), which is pinned to the TypeScript validator by a generated
//! corpus.

pub mod catalog;
pub mod components;
pub mod lz;
pub mod oauth;
pub mod protocol;
pub mod render;
pub mod store;
pub mod tools;
