# Intent: src/types.ts modifications

## What changed
Added `image?: string` to the `ContainerConfig` interface, allowing a group to
specify a custom container image that overrides the global `CONTAINER_IMAGE`
default.

## Key sections

### ContainerConfig interface
- Added: `image?: string` field with inline comment explaining the default fallback

## Invariants (must-keep)
- All other fields of `ContainerConfig` (`additionalMounts`, `timeout`) unchanged
- All other interfaces in this file (`RegisteredGroup`, `AdditionalMount`,
  `MountAllowlist`, etc.) unchanged
