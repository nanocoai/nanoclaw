# Automation Scout

Automation opportunities:
- Add a small avatar recolor script for future agent variants.
- Inputs: source NanoClaw profile image, target hue/saturation/value curve, optional accessory overlay.
- Output: 1024 x 1024 PNG/JPEG pair.

Impact:
- Medium. It prevents repeated manual Python snippets and keeps visual variants consistent.

Difficulty:
- Low to medium. Current recolor logic can be extracted into `scripts/recolor-agent-avatar.ts` or Python if Pillow remains acceptable.
