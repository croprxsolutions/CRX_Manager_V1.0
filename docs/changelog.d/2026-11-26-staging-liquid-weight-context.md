## 2026-11-26 - Prepare staging for liquid weight review

The staging database job and its local schema comparison can now identify the one migration that will open liquid weight review on staging. The staging job verifies the switch opened before recording the migration. This preparation leaves the current switch closed.
