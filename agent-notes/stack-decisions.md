# Stack decisions
Why FitApp uses the stack it does.

Last updated: 2026-10-10

- **Flask (server-rendered Jinja templates)**: the user asked for Python and wants to go one step at a time, so we use the simplest option and can add a JS front end later if needed.
- **Mobile-first**: the target is phone screens. Every page has the `width=device-width` viewport meta, content is capped at 480px wide, and height uses `100dvh` so mobile browser toolbars don't break the layout.
- **Localhost only**: the server binds to `127.0.0.1:5000`. Don't change this to `0.0.0.0` or deploy anything until the user says so.
- **UI testing**: there's no Node in this environment. To check JS behavior and take screenshots, install Playwright with Firefox in the session scratchpad (never in the project `.venv`) and drive it at a 390×844 viewport.
- **Bottom bar (user requirement)**: a compact 44px bar with **Today**, a **Library** menu, and **Progress**. Progress's placement is temporary: the user will decide where it goes. The Library menu pops up Routines / Workouts / Exercises (`static/nav.js`). The button always reads "Library" (user requirement) and turns accent-colored while you're in one of its sections. Form pages (builders, editors) hide the bar. The rest-timer bar and toast offsets in `style.css` are tied to its height. **Mobile (user, 2026-10-10):** the bar is **Tracking** (a menu: Today, Progress), **Library** (Routines / Workouts / Exercises) and a gear icon for **Settings** (`#/settings`, `mobile/src/ui/views/settings.ts`: rest timer, quick fill, autoregulation, and the backup export / import, which moved there from Library). Menu buttons keep a fixed label and turn accent-colored on any of their screens; `wireNav` in `ui/app.ts` handles every `.tab-menu-btn`, and the first menu opens from the left edge so it isn't clipped.
