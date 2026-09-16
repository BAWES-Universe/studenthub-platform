# Linear completion-gate probe (disposable)

This file exists only to give PR for SHU-273 a real diff so it can be merged as a bounded
workflow probe. It asserts nothing about the product and is removed immediately afterwards.

Purpose: prove that merging a PR whose body references a Linear issue with `Refs` — on a branch
whose name contains that issue's identifier — does **not** transition the issue to Done, and that
Done is only reached by an explicit acceptance transition.
