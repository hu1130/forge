---
name: forge-fastapi-service
description: Create or extend FastAPI services with explicit request contracts, simple structure, and request-level verification.
---

# Forge FastAPI Service

Use this skill for FastAPI endpoints, small services, model/API adapters, and RAG backends.

1. Inspect the existing project layout, dependencies, configuration, and test conventions first.
2. Define the request, response, validation errors, failure behavior, and configuration inputs before editing.
3. Prefer the smallest route-service structure that fits the current project. Do not introduce new layers without a concrete need.
4. Keep secrets in environment or platform-secure storage and never return them in responses or logs.
5. Preserve async boundaries: do not block an async route with avoidable synchronous network or file work.
6. Verify with the existing test suite and at least one request-level success case and one relevant failure case.
