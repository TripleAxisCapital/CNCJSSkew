# CNCJSSkew

Offline two-point workpiece alignment for **CNCjs + GRBL**, built for two-sided precision work such as a watch case on a Shapeoko 3.

CNCJSSkew lets you clamp a part slightly crooked, manually jog to two known reference points, capture those locations, and then load a rotated/translated copy of the G-code that matches the real workpiece. It does **not** use an electrical probe and it does **not** change GRBL EEPROM settings.

## What it does

Given two reference points whose CAD/program coordinates are known, CNCJSSkew records their actual GRBL **work coordinates** and solves one rigid 2D transform:

- X translation
- Y translation
- XY rotation (de-skew)
- no scaling

It then safely rewrites supported XY motion in the currently loaded G-code and loads the aligned copy back into CNCjs for visual inspection. Z is left untouched, so you still establish Z normally for each side of the workpiece.

The original G-code is retained in the widget and can be restored with one button.

## Intended watch workflow

In Fusion 360, place two small reference holes in disposable stock around the watch. Example:

- Point A: `X0 Y-40`
- Point B: `X0 Y+40`

The holes do **not** have to be parallel to the Shapeoko's physical Y rail when the stock is clamped.

For each side:

1. Load the original Fusion G-code into CNCjs.
2. Jog the tool manually to the exact center of physical reference hole A.
3. Click **Capture current position as A**.
4. Jog to reference hole B.
5. Click **Capture current position as B**.
6. CNCJSSkew automatically calculates rotation and translation.
7. Click **Apply & load aligned preview**.
8. Inspect the normal CNCjs visualizer.
9. Run the job with CNCjs's normal Run control.
10. After flipping the stock, load the Side 2 G-code and repeat the two captures.
11. Re-establish Z for Side 2 as normal.

## Safety design

CNCJSSkew is deliberately conservative. It is designed to fail closed instead of silently creating questionable G-code.

It currently targets **GRBL 3-axis milling** and typical Fusion 360 output. It supports:

- G0/G1 XY motion
- G2/G3 arcs in the G17 XY plane
- absolute and incremental positioning
- millimeter and inch programs
- G53 Z-only retract moves
- one work coordinate system such as G54

It refuses or blocks risky/ambiguous cases including:

- G53 moves containing X or Y
- multiple work coordinate systems in one program
- G68/G69 program rotation
- G50/G51 scaling
- G90.1/G91.1 arc-center modes
- XY probing/canned cycles
- non-G17 arcs when XY rotation is required
- dynamic macro expressions using `#` or `[ ]`
- an already-aligned CNCJSSkew file (prevents accidental double transformation)

Reference spacing is checked before alignment. If the measured distance between A and B differs from the CAD distance beyond the configured limit, the widget refuses to apply the transform.

## Raspberry Pi installation

Everything runs locally on the Raspberry Pi. GitHub is only used to download/update the files.

### 1. Download the repository

If Git authentication is already configured on the Pi:

```bash
git clone https://github.com/TripleAxisCapital/CNCJSSkew.git
cd CNCJSSkew
```

Because this repository is private, the Pi must be authenticated to GitHub. If you use GitHub CLI, a convenient option is:

```bash
gh auth login
gh repo clone TripleAxisCapital/CNCJSSkew
cd CNCJSSkew
```

### 2. Install the local CNCjs mount

```bash
chmod +x install.sh
./install.sh
```

The installer safely merges this local mount into `~/.cncrc`:

```text
/cncjs-skew  ->  <this repository>/widget
```

If `~/.cncrc` already exists, a timestamped backup is created before any change.

### 3. Restart CNCjs

Restart CNCjs using however you normally run it. For example, if your CNCjs service is managed by PM2 and named `cncjs`:

```bash
pm2 restart cncjs
```

### 4. Add the widget in CNCjs

Open CNCjs in your browser, then:

1. **Manage Widgets**
2. Add a **Custom Widget**
3. Open its settings
4. Set the URL to:

```text
/cncjs-skew/
```

The widget is now served entirely by the Raspberry Pi. Internet access is not required for machining.

## Updating

From the repository directory on the Pi:

```bash
git pull
```

No build step and no npm install are required. Refresh CNCjs after updating. If `install.sh` itself changes the local mount in a future version, simply run it again.

## Uninstalling

```bash
./uninstall.sh
```

Then restart CNCjs. The script removes only the `/cncjs-skew` mount entry from `~/.cncrc`; it does not delete your repository.

## Development and tests

The widget intentionally has **no runtime package dependencies**. CNCjs itself serves the matching Socket.IO client locally from `/socket.io/socket.io.js`.

Run the pure alignment/G-code tests with:

```bash
npm test
```

No GitHub Pages, GitHub Actions, CDN, cloud service, or external runtime is required.

## Important machining notes

- Capture points use the active GRBL **work coordinate system**. Do not change WCS after capturing A/B.
- If the program explicitly selects G54, capture A/B while G54 is active.
- The two CAD coordinates entered in the widget must exactly match the same two physical references in the Fusion setup.
- The widget de-skews XY only. It does not correct Z tilt or surface flatness.
- Alignment accuracy cannot exceed how accurately you place the tool at the reference centers.
- Always inspect the transformed path in the normal CNCjs visualizer before running.

## License

MIT
