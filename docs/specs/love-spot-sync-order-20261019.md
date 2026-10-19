# Love Spot · stable concurrent drawing sync

Continue the sole failing ship gate on the newer d9f2a0ff4 integration, retaining the A29 save guard. Both windows can add shapes concurrently, but different insertion orders make Excalidraw repeatedly repair layer indices; these automatic version bumps can defeat a deliberate deletion.

- Concurrent additions survive in both real canvases. After publication settles, idle windows do not keep changing element versions or layer indices.
- Copy acknowledges received shapes before Delete. Delete propagates in both directions within the existing 700 ms wait and 1 second overall bound.
- Preserve deliberate Undo/Redo, equal-version deletion precedence, remote-history isolation, live text journals, pages and screenshots.
- Use one shared ordering path before Excalidraw restoration/update; choose conflict winners from published metadata before index repair can bump versions. A legacy live snapshot must not revive a pending equal-version Delete; deliberate higher-version Undo still works.
- Evaluate the existing native exchange case and an idle-version regression before production changes. Then run the full standalone file, relevant history/store/renderer checks, build/types/inventory and inspect private captures. No real profile, paid inference, installation or restart.
