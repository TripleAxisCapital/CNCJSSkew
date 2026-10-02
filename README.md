# CNCJSSkew

Offline two-point workpiece alignment for **CNCjs + GRBL**, built for two-sided precision work such as a watch case on a Shapeoko 3.

CNCJSSkew lets you clamp a part slightly crooked, manually jog to two known reference points, capture them, and then automatically rotate + translate the loaded G-code so the toolpath matches the real workpiece.

It does **not** use an electrical probe, does **not** change GRBL EEPROM settings, and does **not** need the internet after installation.

---

# SIMPLE INSTALL — Raspberry Pi

These are the exact steps for a Raspberry Pi that does **not** have Git/GitHub set up yet.

## 1. Install Git + GitHub CLI

Copy and paste:

```bash
sudo apt update
sudo apt install -y git gh
```

Check that both installed:

```bash
git --version
gh --version
```

You should see a version number for both.

---

## 2. Log the Raspberry Pi into GitHub

Run:

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

GitHub CLI will show a short one-time code.

Open the address it gives you on your normal computer or phone, sign into GitHub, enter the code, and approve access.

Then check the Pi is logged in:

```bash
gh auth status
```

You should see that you are logged into `github.com`.

You normally only need to do this once.

---

## 3. Download CNCJSSkew onto the Pi

Copy and paste:

```bash
cd ~
gh repo clone TripleAxisCapital/CNCJSSkew
cd CNCJSSkew
```

Check the files:

```bash
ls
```

You should see files/folders including:

```text
README.md
install.sh
uninstall.sh
widget
scripts
tests
package.json
```

---

## 4. Install CNCJSSkew into CNCjs

Copy and paste:

```bash
chmod +x install.sh
./install.sh
```

The installer adds this local CNCjs mount:

```text
/cncjs-skew/  ->  ~/CNCJSSkew/widget
```

The installer preserves the rest of your CNCjs configuration and makes a backup of `~/.cncrc` before modifying it.

---

## 5. Restart CNCjs

First see how CNCjs is running:

```bash
pm2 list
```

If the CNCjs process is named `cncjs`, restart it with:

```bash
pm2 restart cncjs
```

If the process has a different name, restart that name instead.

Example:

```bash
pm2 restart CNCjs
```

If `pm2` is not being used on your Pi, restart CNCjs the same way you normally start/stop it.

---

## 6. Add CNCJSSkew inside CNCjs

Open CNCjs normally in your browser.

Then:

1. Click **Manage Widgets**
2. Add a **Custom Widget**
3. Open the Custom Widget settings
4. Set the widget URL to:

```text
/cncjs-skew/
```

The **CNCJSSkew · Workpiece Align** panel should appear.

At this point the widget is completely local on the Raspberry Pi.

**You can disconnect the Pi from the internet and CNCJSSkew will still work.**

---

# SIMPLE WATCH SETUP

In Fusion 360, create two small reference holes in disposable stock around the watch.

Example:

```text
Point A = X0  Y-40
Point B = X0  Y+40
```

The exact coordinates can be different. The important thing is that you know the exact CAD X/Y coordinate of both holes.

The physical stock does **not** have to be perfectly aligned with the Shapeoko X/Y rails.

Example:

```text
Machine Y
   ↑
   │                 ● B
   │                /
   │               /
   │            WATCH
   │             /
   │            /
   │         ● A
   │
   └────────────────────→ Machine X
```

CNCJSSkew calculates that angle automatically.

---

# HOW TO USE IT

## Side 1

### 1. Load your normal Fusion G-code

Load the original Side 1 G-code into CNCjs normally.

### 2. Enter the CAD coordinates

In CNCJSSkew, enter the exact coordinates of Point A and Point B.

Example:

```text
A: X 0.000   Y -40.000
B: X 0.000   Y +40.000
```

### 3. Capture Point A

Use the normal CNCjs jog controls.

Manually move the spindle/tool until it is exactly centered over physical reference hole A.

Then click:

```text
Capture current position as A
```

No electrical probe is required.

### 4. Capture Point B

Jog to the exact center of physical reference hole B.

Click:

```text
Capture current position as B
```

### 5. Let CNCJSSkew calculate alignment

The widget automatically calculates:

- XY rotation
- X translation
- Y translation
- reference-hole spacing error

If the two captured points do not make sense compared with the CAD points, CNCJSSkew refuses to apply the alignment.

### 6. Apply the alignment

Click:

```text
Apply & load aligned preview
```

CNCJSSkew creates a transformed copy of the G-code and loads it into CNCjs.

It does **not** automatically start the machine.

### 7. Inspect the CNCjs visualizer

Check that the transformed toolpath is where you expect it to be.

Then use CNCjs's normal **Run** control when you are satisfied.

---

# FLIPPING THE WATCH — Side 2

After Side 1:

1. Flip and secure the stock.
2. Load the **original Side 2 Fusion G-code**.
3. Jog to physical Point A.
4. Click **Capture current position as A**.
5. Jog to physical Point B.
6. Click **Capture current position as B**.
7. Click **Apply & load aligned preview**.
8. Inspect the CNCjs visualizer.
9. Re-zero/set **Z** for Side 2 as required.
10. Run the Side 2 job normally.

You do **not** need the stock to return to exactly the same XY position or angle after flipping. CNCJSSkew calculates the new position and rotation again.

---

# WHAT THE ALIGNMENT DOES

Two points define one rigid 2D alignment:

```text
CAD Point A ─┐
             ├─ rotation + X translation + Y translation
CAD Point B ─┘
```

CNCJSSkew transforms the toolpath itself.

It does **not** physically rotate the Shapeoko axes.

It does **not** scale the G-code.

It does **not** change Z.

---

# IMPORTANT SAFETY RULES

CNCJSSkew is deliberately conservative and tries to fail closed instead of silently generating questionable G-code.

Before using it on the real watch:

1. Test it on scrap first.
2. Do the first test with the spindle **OFF**.
3. Keep Z safely above the workpiece.
4. Deliberately clamp the scrap slightly crooked.
5. Capture A and B.
6. Apply the alignment.
7. Run an air-cut and confirm the toolpath follows the crooked workpiece correctly.

Always inspect the transformed path in the normal CNCjs visualizer before running.

Alignment accuracy is only as good as how accurately you position the tool over Point A and Point B.

Using reference points farther apart improves angular accuracy. For a watch blank, roughly **60–100 mm apart** is a useful target when the stock allows it.

---

# SUPPORTED G-CODE

CNCJSSkew is currently intended for **GRBL 3-axis milling** and normal Fusion 360 output.

It supports common cases including:

- G0 / G1 XY motion
- G2 / G3 arcs in the G17 XY plane
- G90 / G91
- G20 / G21
- G53 Z-only retract moves
- one work coordinate system such as G54

For safety, it refuses ambiguous or risky cases such as:

- G53 moves containing X or Y
- multiple work coordinate systems in one file
- G68 / G69 rotation
- G50 / G51 scaling
- unsupported arc-center modes
- XY probing/canned cycles
- non-G17 arcs when rotation is required
- dynamic macro expressions using `#` or `[ ]`
- attempting to align an already CNCJSSkew-aligned file again

---

# UPDATE CNCJSSkew LATER

When this repository gets updated, go to the Pi and run:

```bash
cd ~/CNCJSSkew
git pull
```

Then refresh CNCjs in the browser.

Normally there is no build step and no `npm install`.

If the installer itself changes in a future update, simply run:

```bash
cd ~/CNCJSSkew
./install.sh
```

and restart CNCjs.

---

# TEST THE CODE

Optional, but useful after downloading/updating:

```bash
cd ~/CNCJSSkew
npm test
```

---

# UNINSTALL

From the Pi:

```bash
cd ~/CNCJSSkew
./uninstall.sh
```

Then restart CNCjs.

The uninstall script removes only the CNCJSSkew mount from `~/.cncrc`. It does not delete the repository.

---

# OFFLINE DESIGN

GitHub is only used to download/update the project.

There is:

- no GitHub Pages
- no GitHub Actions dependency
- no CDN dependency
- no cloud runtime
- no internet requirement while machining

The widget, alignment math, and G-code transformation all run locally through the Raspberry Pi + CNCjs.

---

# License

MIT
