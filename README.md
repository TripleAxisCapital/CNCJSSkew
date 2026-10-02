# CNCJSSkew

A local CNCjs widget for **two-point workpiece alignment on GRBL/Shapeoko**.

Clamp the workpiece slightly crooked, capture two known reference points, and CNCJSSkew rotates + translates the loaded G-code so the toolpath matches the real part.

Everything runs locally on the Raspberry Pi. GitHub is only used to download or update the files.

---

# Update an existing installation

If CNCJSSkew is already installed on your Raspberry Pi, this update is very simple.

Copy and paste:

```bash
cd ~/CNCJSSkew && git pull
```

Then reload CNCjs in your browser.

If the old interface is still cached, do a hard refresh:

- Windows/Linux: `Ctrl + Shift + R`
- Mac: `Cmd + Shift + R`

You **do not need to reinstall the widget**. The existing `/cncjs-skew/` mount already points at this folder.

---

# First-time install

## 1 — Install Git + GitHub CLI

```bash
sudo apt update && sudo apt install -y git gh
```

## 2 — Sign in to GitHub

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

Follow the one-time browser login.

## 3 — Download + install CNCJSSkew

```bash
cd ~ && gh repo clone TripleAxisCapital/CNCJSSkew && cd CNCJSSkew && ./setup.sh
```

Then in CNCjs:

**Manage Widgets → Add Custom Widget**

Set the URL to:

```text
/cncjs-skew/
```

That is it.

---

# The simple workflow

For the watch, create two reference holes in Fusion 360 and know their exact CAD coordinates.

Example:

```text
A = X0 Y-40
B = X0 Y+40
```

Then:

1. Load the original Fusion G-code in CNCjs.
2. Enter the CAD X/Y coordinates for A and B.
3. Jog to the exact physical center of A and press **Capture current position**.
4. Jog to B and press **Capture current position**.
5. CNCJSSkew calculates XY rotation + X/Y translation.
6. Press **Apply alignment**.
7. Inspect the normal CNCjs visualizer.
8. Run normally.

No electrical probe is required.

---

# Auto-align every toolpath

You no longer have to press **Apply alignment** for every file.

After you have a good alignment:

1. Enter a name under **Favorites**.
2. Press **Save**.
3. Select that favorite.
4. Press **Use as default**.

That automatically turns on **Auto-align**.

From then on, every newly loaded **original** G-code file is automatically transformed with that saved alignment and reloaded as an aligned preview.

CNCJSSkew never starts the machine automatically. You still inspect the CNCjs visualizer and press Run yourself.

### Important

A saved alignment contains the physical XY rotation/translation for that fixture/workpiece position and WCS. If the fixture, stock, or work offset moves, capture A/B again and save a new favorite.

---

# Favorites

Favorites store the complete alignment locally through CNCjs on the Raspberry Pi:

- rotation
- X translation
- Y translation
- CAD A/B coordinates
- captured A/B coordinates
- work coordinate system

You can load any favorite later or mark one as the default.

The default favorite is what Auto-align uses after browser refreshes or Raspberry Pi restarts.

---

# Flip the watch

For Side 2:

1. Flip and secure the stock.
2. Load the original Side 2 G-code.
3. Capture A again.
4. Capture B again.
5. Save this alignment as a favorite if you want to reuse it.
6. Apply it manually or mark it as default for automatic application.
7. Inspect the visualizer.
8. Set/re-zero Z normally.
9. Run Side 2.

CNCJSSkew corrects XY rotation/translation. It does not alter Z.

---

# Midpoint Finder

The widget also includes **Midpoint Finder**.

You can either type two arbitrary XY points with the keyboard or capture the current machine position for each point.

Choose:

- **X middle** — calculates `(X1 + X2) / 2`
- **Y middle** — calculates `(Y1 + Y2) / 2`
- **XY middle** — calculates the diagonal midpoint of both axes

You can also press **Use alignment A + B** to instantly use the two alignment reference points.

---

# Safety limits

Open **Safety checks** at the bottom of the widget.

Both limits are completely editable:

- maximum spacing mismatch
- maximum workpiece rotation

There are **no hard upper caps**. Enter any non-negative value you want.

You can also switch either check completely **Off**.

The only rule that cannot be disabled is mathematical: A and B must be two different points.

---

# Keyboard input

All coordinate and limit fields are normal keyboard-editable text fields with decimal input support.

Live GRBL position updates no longer rebuild the interface while you are typing, so keyboard focus stays in the field.

Press **Enter** to commit a value, or click outside the field.

---

# Before using the real watch

Do one air-cut first:

1. Use scrap.
2. Clamp it slightly crooked on purpose.
3. Keep the spindle **OFF**.
4. Keep Z safely above the material.
5. Capture A and B.
6. Apply alignment.
7. Run a simple test path.
8. Confirm the path follows the crooked workpiece correctly.

Always inspect the aligned preview before a real cut.

For good angular accuracy, put A and B as far apart as practical. Roughly **60–100 mm apart** is a useful target for this watch setup when the stock allows it.

---

# Test the code

```bash
cd ~/CNCJSSkew && npm test
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
