# Intellectual Property & Licensing Notice (Open Interface · Closed Kernel)

`artificial-mind-engine` follows an **Open Interface / Closed Kernel** architecture:

1. **Open-Source Scope (MIT License — Included in This Repository)**:
   - OpenAPI 3.1 Gateway specification (`spec/openapi.yaml`)
   - Client SDKs (`packages/sdk-ts`, `packages/sdk-python`) and Pluggable LLM provider adapters
   - Domain output adapters & application templates (`examples/game-npc`, `examples/companion-chat`, `examples/counseling-coach`)
   - Local contract sandbox server (`packages/sandbox-server`) for zero-key development and integration testing
   - Black-box verification & governance benchmark harness (`benchmarks/cogeval-locomo-harness`)

2. **Proprietary Closed-Kernel Scope (All Rights Reserved — Excluded from Source Repository)**:
   - The compiled/sealed `ame-kernel` runtime (`ghcr.io/bearrhee/ame-kernel-sealed:latest` or Managed API) containing proprietary cognitive kernel implementations (AACIM-59 continuous state dynamics, FEP selective `<thought>` lock, Rescorla-Wagner concave somatic markers, 3-tier hybrid RAG + epoch-stable KV-cache alignment, `D3` triple atomic revocation, and `D4` unconscious-conscious firewall) remains closed-source proprietary intellectual property.
   - Use of the sealed container image or hosted API requires a separate commercial or evaluation license agreement.
