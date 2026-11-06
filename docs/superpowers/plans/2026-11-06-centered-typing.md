# Center the active reading line

The active English line should sit in the vertical middle of the unobscured reading area below the sticky toolbar, including chapter notices. Preserve the inline input, exact drafts, alignment and automatic paragraph advancement.

Implementation: retain native input and RAF positioning; center the line with a bounded settle for the toolbar entering sticky positioning. Keep a following state across input, paragraph changes and explicit return. Layout observers recenter only while following; manual wheel, touch or other unowned scrolling suspends it. Register internal prepend compensation as owned scrolling and disable competing browser scroll anchoring in the reading area. Reading-only bottom space permits the final short paragraph to center.

Validation: reproduce the original restored-line offset before implementation; isolate desktop tests for restore, long-line typing, no same-line jitter, chapter acknowledgement and delayed notices, resize/fonts, manual browsing and a short last paragraph. Run existing unit/desktop/performance and packaged checks. Back up the complete real desktop profile through a verified unpackaged process before installation, check parity, and verify an ordinary installed launch.
