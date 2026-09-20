# Generated character and boat assets

Generated for the approved visual reference on 2026-09-20 using the built-in image generation tool. No CLI/API fallback was used. The reference is the supplied image `codex-clipboard-08b22d40-d31b-470a-9b3d-7a060d2944e7.png`.

## Delivery and format

| Runtime path | Layout / purpose |
| --- | --- |
| `game/assets/characters/siren-atlas.webp` | Three equal horizontal cells: idle, singing, listening |
| `game/assets/characters/siren-mask.webp` | Generated registered black/white luminance mask for siren atlas |
| `game/assets/boats/boats-atlas.webp` | Three equal horizontal cells: coral, yellow, mint |
| `game/assets/boats/boats-mask.webp` | Generated registered black/white luminance mask for boat atlas |

All four images are **1774 × 887 pixels**. Each cell is **1774 / 3 × 887**, giving a **2:3** cell aspect ratio. Framing includes padding. Character mask artwork occupies roughly y=106 through850; boat mask artwork occupies roughly y=179 through728. Keep each atlas and its matching mask registered.

Source PNGs are preserved in `art-source/generated/` with corresponding names. The source images are 24-bit RGB. **Actual alpha generation did not succeed**: initial requests and one targeted correction produced a baked checkerboard. These are therefore deployed using separate image-generated luminance masks. Never display either atlas without its mask. No local background extraction or manual repainting was applied.

The packaging script `art-source/package-sprites.py` copies originals and encodes color WebP at quality90, and lossless mask WebP, preserving dimensions. It does not crop, recolor, resize or extract backgrounds.

## Frontend use

Use matching background and mask sizes `300% 100%`, and matching background and mask positions `0% 0%`, `50% 0%`, `100% 0%`. Set `mask-mode: luminance`, and `mask-repeat: no-repeat`. Runtime element aspect ratio is `2 / 3`. Do not use the opaque mask as an alpha mask without luminance interpretation.

For Canvas share rendering, use the same generated mask's luminance as the coverage channel. Do not reproduce the checkerboard in exported cards.

The masks are model-generated and visually closely aligned but not an analytically exact cutout. Inspect on the sea at the actual displayed size; very small edge discrepancies may remain. The character outline is thinner relative to the sprite than the boat outline, consistent with reference.

## Original generation prompts

### Character atlas

Use case: stylized-concept.
Asset type: production transparent PNG character sprite atlas for a cheerful storybook sea game.
Input image 1 is a STYLE AND CHARACTER REFERENCE ONLY. Match the exact blue-haired siren at lower left: large gently wavy cobalt blue hair, shell with coral hair ornament, pearl earrings, pale icy-blue off-shoulder flowing dress, black handdrawn outlines, rosy cheeks, handheld gray microphone, barefoot. This is friendly cute clean 2D cartoon art, not pixel art.
Create THREE full-body sprites of this SAME character, arranged in exactly three equal-width columns in ONE horizontal row. Canvas 1920 x 960 preferred; each of the three cells 640 x 960. Transparent RGBA background with real alpha, no white or checkerboard backdrop. There must be generous clear transparent space between the three cells. Every sprite is seated on an invisible rock, with her hips at the same height, body facing right, legs extended downward in her flowing skirt; keep identical head size, body scale, baseline and placement in each cell. Entire silhouette fully inside cell with padding and no cropping.
LEFT CELL: idle, eyes open, mouth closed pleasant smile, microphone lowered near lap.
MIDDLE CELL: singing, happy open mouth, microphone held up near mouth, eyes open expressive.
RIGHT CELL: listening, eyes open, closed mouth, microphone lowered in one hand, the other hand raised near ear in a listening pose.
Render ONLY the three character cutouts. No rock, sea, background, UI, letters, labels, numbers, music notes, floating icons, cast shadows or opaque backdrop. No changing her clothing/hair/accessories between cells. Refined organic near-black thick outlines and airy aqua/cobalt/coral palette matching reference. True transparency is essential.

### Boat atlas

Use case: stylized-concept.
Asset type: transparent PNG front-facing cute boat sprite atlas, three color variants for a 2D cheerful sea game.
Input image 1 is STYLE AND SUBJECT REFERENCE ONLY. Closely match the cute front-facing smiling boat in the center of the reference image, clean near-black thick handdrawn outline, cream cabin and hull upper, little cabin roof, two upward curved happy closed-eye window marks, one short mast and triangular coral orange flag. Slight handpainted shading, uncomplicated shape, delightful friendly illustration matching the supplied image, NOT pixel art.
Create EXACTLY THREE boats arranged left-to-right in ONE horizontal row in three equal cells, same proportions, outline, camera, size, position and baseline in all three cells. Preferred canvas 1536x768 with each cell 512x768. Front view centered facing directly toward viewer, keep complete silhouette, ample transparent padding. LEFT boat coral red lower hull. MIDDLE boat golden yellow lower hull. RIGHT boat mint turquoise lower hull. Each retains coral orange flag. Flag and mast fully visible.
Background must be genuine transparent RGBA with real alpha. Output ONLY these three separated clean boat sprites. No horizon, sea, water, wakes, splashes, ripples, cast shadow, highlights floating outside boat, rocks, text, numbers, frame, checkerboard, backdrop or UI. All three boats must be independent clean cutouts ready to animate over the sea.

### Attempted alpha correction (not selected)

Use case: background-extraction. Edit target: image 1, a character sprite atlas. Remove ONLY the gray checkerboard background completely. Return a true RGBA PNG file with alpha=0 everywhere outside the character silhouettes, not a visual simulation of transparency. The output file must contain an actual alpha channel. Do not draw any checkerboard at all. Keep the three characters, outlines, positions, size and colors exactly unchanged. The background should contain no pixels, no matte and no color. Three separated character cutouts on REAL transparent alpha.

### Character luminance mask

Use case: precise-object-edit.
Edit target: the supplied 1774 x 887 sprite atlas. Create an EXACT registered silhouette MASK of this image, 1774 x 887 dimensions, unmodified crop, camera or registration.
Every pixel belonging to any part of the three character sprites must be PURE WHITE (#ffffff), including the black outlines, fingers, microphone, hair, feet and all clothing. Everything outside the silhouettes, including all the gray checkerboard background and the holes between hair curls, arms and body, must be PURE BLACK (#000000). Edges must exactly coincide with original sprite edges. White solid flat silhouettes only. No visible internal details: white fill across the entire character, absolutely no lines or shading inside each silhouette. The desired result is three solid white character silhouettes in same positions on solid black background, for a luminance mask. Preserve precise shapes/positions/sizes of the input. Do not redesign or move anything. Do not output transparency or checkerboard: opaque black and white mask.

### Boat luminance mask

Use case: precise-object-edit. Edit target: supplied 1774 x 887 boat sprite atlas. Create an EXACT registered black and white SILHOUETTE MASK at the identical 1774 x 887 dimensions and framing. Every pixel belonging to one of the three boat sprites, including all near-black outlines, hulls, cabin, mast and triangular flag, becomes PURE WHITE. ALL other pixels including gray checkerboard and the holes between railing and cabin become PURE BLACK. Return three SOLID WHITE full boat silhouettes on solid black. Keep exact edges and placement of each boat from the original image. No internal lines, colors, gray details or shading; all internal boat content is solid white. Only the exterior silhouette and real empty holes distinguish white from black. No checkerboard. No transparency request. This is a luminance mask used to reveal the original sprites with precise alignment; don't move or change anything.

## Provenance

- Character color source: `exec-c6098db6-8e1e-4993-9a38-4ad8562f66c3.png`
- Character mask source: `exec-2bf3641d-bb17-4431-bd3a-ec6df672d1c8.png`
- Boat color source: `exec-be513d51-e98d-4af4-819d-b85a381e13fa.png`
- Boat mask source: `exec-de33f856-08ce-4152-a9c6-c117ad55ee69.png`
- Built-in output directory: `C:/Users/aisd/.codex/generated_images/01a0bb66-462f-7292-945f-8463fd6e6a20/`

