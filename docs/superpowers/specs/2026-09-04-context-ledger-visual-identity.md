# Context Ledger visual identity

## Desired user-visible outcome

The persistent Ledger should let Masih distinguish measured occupancy from the exact
run-built request composition at a glance, with the same category values as `/context` and no
black residual, opaque aggregate, or manufactured gap.

## Challenged decisions

- **Keep:** distinct category hues. Color is a fast scan aid and Masih explicitly requires it.
- **Rewrite:** color-only identification becomes color plus a unique one-cell symbol, so nearby
  hues and limited terminals remain distinguishable.
- **Rewrite:** the second bar is request composition normalized to the category sum. Rendering
  its unused share of the provider window as gray falsely looks like an unexplained category.
- **Keep:** measured provider occupancy remains a separate bar normalized to the context window.
- **Keep:** instruction content uses a darker crimson than the previous bright red/pink while
  remaining readable on the dark terminal background.
- **Defer:** the HTML dashboard redesign is a separate implementation task because it has a
  different renderer, build pipeline, and screenshot acceptance harness.

## Acceptance harness

- [ ] A seeded 52-column Ledger labels `MEASURED OCCUPANCY` and `REQUEST COMPOSITION` as
      separate measurements.
- [ ] Request composition shows its unpadded category sum, fills only with real categories, and
      has no free-space cells or residual/gap label.
- [ ] Every category row shows a unique symbol, full label, token count, and percentage of the
      run-built request.
- [ ] `/context` and the Ledger are built from the same category objects and render the same
      category token values.
- [ ] No category uses black; System instructions use the approved darker crimson.
- [ ] Missing request attribution says it is unavailable and does not invent a category.
- [ ] The real installed TUI is rendered and visually accepted by Masih before this work is
      called verified.

## Non-goals

- Reconciling provider-measured occupancy with the client estimate by inventing tokens.
- Changing core token accounting or Smart Prune behavior.
- Claiming that a source render or snapshot is Masih's visual acceptance.
