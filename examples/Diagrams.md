# Diagram examples

## Flowchart

```mermaid
flowchart LR
  A[Read Markdown] --> B{Contains Mermaid?}
  B -->|Yes| C[Render diagram]
  B -->|No| D[Show document]
```

## Sequence diagram

```mermaid
sequenceDiagram
  participant User
  participant Leaf
  User->>Leaf: Open a document
  Leaf-->>User: Show formatted content
```

## Invalid source stays readable

This intentional syntax error demonstrates the fallback:

```mermaid
flowchart TD
  A[Unclosed node
```
