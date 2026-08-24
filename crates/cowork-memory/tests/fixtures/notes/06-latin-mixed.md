---
project: cowork-deck
---
# Mixed script note

## TL;DR
The sidecar keeps ONNX out of the main binary; the app only spawns it.
Markdown is the source of truth and the index is a disposable cache.

## Detail
Русский и латиница в одном файле проверяют, что счётчик букв и обрезка по
символам работают на многобайтовых строках так же, как в питоновской версии.
