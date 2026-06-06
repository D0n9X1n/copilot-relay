## Summary

<!-- What changed and why? -->

## Scope

<!-- Keep this focused on Claude Code unless the product direction changed. -->

## Validation

- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run build`

## Notes

<!-- Mention config changes, logging changes, or token/auth implications. -->

## Checklist

- [ ] Public API remains Claude Code-only unless intentionally changed.
- [ ] Config changes are reflected in `config.default.yaml`, README, and docs.
- [ ] Logs do not expose tokens.
- [ ] Integration tests mock upstream Copilot; they do not call real Copilot services.
