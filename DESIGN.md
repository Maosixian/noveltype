# NovelType Arcade

Accepted direction: the coastal Apple Arcade inspired concept in the prior review,
now integrated with the real desktop library, account and game states.

- A dark, compact global bar separates exploration, expedition and reading.
- The game lobby and map share the original coastal world artwork. Reading uses
  a quiet light or dark surface, a restrained type scale and generous line spacing.
- Keep the selected book and reading cursor stable across views; games use cached
  content and independent persisted results. No new paid API work from presentation.
- Visual feedback is immediate and bounded: character/word acknowledgement,
  defense impacts and one completion sequence. No continuous decorative effects,
  sound by default, input delay or waiting for animation before progressing.
- Standard, reduced and off motion modes respect the system reduced-motion setting.
- Reuse current DOM nodes in input and animation paths. Update only changed values;
  keep durable progress writes, cloud conflicts and paragraph focus transitions.
- Validate at 1380x930 and 960x760, long titles, dark/light themes, keyboard dialogs,
  reduced motion, saved progress, offline games and synthetic large libraries.

The implementation has one source: app/. The evidence/arcade-v2 concept is not a
second production frontend. Release assets include only the original world image.
