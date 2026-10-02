# CNCJSSkew

A fully local CNCjs widget for **two-point workpiece alignment on GRBL / Shapeoko**.

Capture two known points on the real workpiece and CNCJSSkew rotates + translates the loaded G-code so the toolpath follows the part. It is designed for precision two-sided work such as a watch case.

Everything runs on the Raspberry Pi. GitHub is only used to download or update the project.

## Update an existing installation

If CNCJSSkew is already installed:

```bash
cd ~/CNCJSSkew && git pull
```

Then hard-refresh CNCjs in the browser:

- Windows/Linux: `Ctrl + Shift + R`
- Mac: `Cmd + Shift + R`

The existing `/cncjs-skew/` mount already points at the repo, so no reinstall is normally required.

---

# First-time install

## 1. Install Git + GitHub CLI

```bash
sudo apt update && sudo apt install -y git gh
```

## 2. Sign in to GitHub

```bash
gh auth login
```

Choose:

```text
GitHub.com
HTTPS
Yes
Login with a web browser
```

## 3. Download + install

```bash
cd ~ && gh repo clone TripleAxisCapital/CNCJSSkew && cd CNCJSSkew && ./setup.sh
```

Then in CNCjs:

**Manage Widgets → Add Custom Widget**

Set the URL to:

```text
/cncjs-skew/
```

That is it. Internet is no longer required.

---

# Normal watch workflow

In Fusion 360 create two reference points/holes with known CAD coordinates. Example:

```text
A = X0 Y-40
B = X0 Y+40
```

Then:

1. Load the original Fusion G-code in CNCjs.
2. Enter the CAD coordinates for A and B.
3. Jog to the exact physical center of A → **Capture current position**.
4. Jog to B → **Capture current position**.
5. CNCJSSkew calculates XY rotation + X/Y translation automatically.
6. Inspect the displayed alignment.
7. Press **Apply alignment**, or save it as a fixture profile and enable Auto-align.
8. Inspect the normal CNCjs visualizer.
9. Run normally.

CNCJSSkew never starts the machine automatically.

---

# Fixture profiles + Auto-align

A fixture profile stores:

- XY rotation and translation
- CAD A/B coordinates
- optional CAD verification point C
- captured A/B points
- WCS (G54/G55/etc.)
- the saved XY work-offset fingerprint
- Safe Z for midpoint movement
- last successful verification metadata

After creating a good alignment:

1. Give it a name, for example `Watch Case · Side 1`.
2. Press **Save new**.
3. Press **Use as default**.

Auto-align turns on. From then on, newly loaded **original** G-code files are transformed automatically and reloaded as aligned previews.

The widget never presses Run.

## Automatic invalidation

Auto-align pauses rather than silently using a questionable profile if:

- the active WCS no longer matches the saved profile
- the XY work offset has moved beyond the configured tolerance
- the profile has unsaved changes
- an independent point-C verification failed
- the saved profile predates work-offset fingerprinting

If a fixture or work offset physically changes, re-capture A/B and update or save a new profile.

---

# Third-point verification

A and B define the alignment. Optional point **C** verifies it independently and does **not** change the transform.

1. Enter C's CAD X/Y coordinates.
2. Jog to the exact physical center of C.
3. Press **Verify at current position**.

CNCJSSkew shows:

- expected C position
- measured C position
- XY residual error
- quality label

A failed C verification pauses Auto-align for that active profile until it is successfully verified again or A/B are re-captured.

---

# Alignment health

CNCJSSkew reports a residual-based health label rather than a fake accuracy percentage.

Defaults:

```text
Excellent   ≤ 0.025 mm
Good        ≤ 0.050 mm
Acceptable  ≤ 0.100 mm
Check       > 0.100 mm
```

All three thresholds are editable under **Safety & quality**.

Without point C, the health result is explicitly labeled **A/B geometry only**. With C, it is an independent verification result.

---

# Midpoint Finder

Enter or capture any two XY points and choose:

- **X middle** → `(X1 + X2) / 2`
- **Y middle** → `(Y1 + Y2) / 2`
- **XY middle** → diagonal midpoint of both axes

You can also press **Use alignment A + B**.

## Safe Move to Midpoint

Set **Safe Z** in work-coordinate millimeters and press **Move to midpoint**.

The move is deliberately conservative:

1. CNCJSSkew uses the higher of current Z or Safe Z, so it does not lower Z before horizontal travel.
2. It retracts Z first.
3. `G4 P0` drains the GRBL planner so the Z move completes before XY starts.
4. It moves X, Y, or XY depending on the selected midpoint mode.
5. It restores inch/mm and absolute/incremental distance mode if they were changed for the move.

The spindle is never started or stopped by this feature.

Safe Z is a **work-coordinate Z value**. Set it to a height that is clear of the stock, clamps, and fixture.

---

# Safety & quality settings

The UI does not impose arbitrary upper caps.

You can edit:

- maximum A↔B spacing mismatch
- maximum workpiece rotation
- work-offset change tolerance
- Excellent / Good / Acceptable residual thresholds
- Safe Z

Spacing and rotation checks can be switched off entirely.

The only non-disableable geometry rule is that A and B must be two different points.

---

# Keyboard input

All coordinate and settings fields are normal keyboard-editable fields.

Live GRBL position updates patch only live status elements; they do **not** rebuild the interface while you are typing.

Press **Enter** or click outside a field to commit its value.

---

# Flip / Side 2

After Side 1:

1. Flip and secure the stock.
2. Load the original Side 2 G-code.
3. Re-capture A and B.
4. Optionally verify C.
5. Save/update a Side 2 fixture profile if useful.
6. Apply the alignment or use Auto-align.
7. Inspect the visualizer.
8. Re-zero Z normally.
9. Run Side 2.

CNCJSSkew corrects XY rotation/translation. It does not alter machining Z in the transformed toolpath.

---

# Before the real watch

Do an air-cut first:

1. Use scrap.
2. Clamp it slightly crooked on purpose.
3. Keep the spindle **OFF**.
4. Keep Z safely above the material.
5. Capture A and B.
6. Verify C if available.
7. Apply alignment.
8. Run a simple test path.
9. Confirm the path follows the crooked workpiece correctly.

Always inspect the aligned preview before a real cut.

For angular accuracy, put A and B as far apart as practical. Roughly **60–100 mm apart** is a useful target for this watch setup when the stock allows it.

---

# Test the code

```bash
cd ~/CNCJSSkew && npm test && npm run check
```

---

# Uninstall

```bash
cd ~/CNCJSSkew && ./uninstall.sh
```

Then restart CNCjs.

---

# Offline by design

There is no GitHub Pages dependency, no GitHub Actions dependency, no CDN, no cloud runtime, and no internet requirement while machining.

# License

MIT
