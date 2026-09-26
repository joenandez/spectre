# Proof Tool Options

Use this only when a project has no adequate existing proof stack or the user asks for options. Prefer the repo's current tools first, and verify current support in primary documentation before recommending or installing anything.

## Selection rules

1. Prefer the existing runner and language unless they cannot exercise the public workflow or preserve the required evidence.
2. Prefer black-box interaction for acceptance proof. Internal APIs are for deterministic setup and supporting diagnostics.
3. Require evidence appropriate to the claim: screenshots for visible states, video for paths/transitions, traces/logs for diagnosis, and durable-state checks for persistence.
4. Isolate profiles, credentials, ports, devices, data, and processes from the user's live environment.
5. Separate assertion tools from presentation tools. Recording a journey does not establish correctness without observable assertions and visual review.

When user selection is required, offer 2-4 viable options as `Tool | Why it fits | Evidence | Setup cost | Limits`, recommend one, and wait before adding dependencies.

## Web apps

| Tool | Choose when | Evidence strengths | Limits |
|---|---|---|---|
| [Playwright](https://playwright.dev/docs/test-use-options) | Default for modern browser E2E, multi-browser proof, traces, and agent-operated workflows. | Screenshots, video, traces, console/network hooks, selectors by role/test id, [visual screenshots](https://playwright.dev/docs/test-snapshots), [ARIA snapshots](https://playwright.dev/docs/aria-snapshots). | Adds Node test stack if absent; visual baselines need deterministic data/fonts/viewports. |
| [Cypress](https://docs.cypress.io/app/guides/screenshots-and-videos) | Repo already uses Cypress, app debugging is browser-centric, or component/E2E coverage exists. | Screenshots/videos, command log, network stubbing, cloud replay when configured. | Built-in screenshots do not compare pixels by themselves; runner UI can leak into media unless configured. |
| [Selenium/WebDriver](https://www.selenium.dev/documentation/webdriver/) | Existing WebDriver grid, enterprise browser/device matrix, or non-JS stack. | Standard browser automation API, screenshots, broad vendor/device support. | More setup and less integrated trace/video story than Playwright. |
| [WebdriverIO](https://webdriver.io/docs/visual-testing/) | WebDriver infrastructure plus built-in visual service or mobile/web cross-surface needs. | Screen/element/full-page screenshot save/check APIs and image comparison service. | Visual results remain environment-sensitive; setup is heavier than a small Playwright proof. |

## Electron and desktop

| Tool | Choose when | Evidence strengths | Limits |
|---|---|---|---|
| [Playwright Electron](https://playwright.dev/docs/api/class-electron) | Electron app can be launched in test mode and renderer-level proof is enough. | Electron launch/control, renderer Playwright actions, screenshots, traces via browser contexts. | Official support is experimental; native window chrome and OS dialogs may need platform capture. |
| [WebdriverIO Electron Service](https://webdriver.io/docs/wdio-electron-service/) | WebdriverIO is established or Electron APIs, main/renderer logs, deep links, and packaged-app discovery matter. | Cross-platform Electron E2E with log capture; visual/video evidence uses companion services/reporters. | The Electron service is a third-party package and adds driver/service configuration. |
| App-specific CDP/WebDriver harness | The repo already exposes a supported isolated app runner. | Usually best fit for real app startup, logs, traces, fixtures, and safe state isolation. | Trust only if it drives public workflows; internal shortcuts are diagnostic unless explicitly scoped. |
| Platform UI drivers | Native window chrome, system dialogs, installer flows, menu bar, or OS integration are the acceptance target. | OS-level interaction and full-window evidence. | Platform-specific setup; often slower/flakier than app-level automation. |

## Native mobile

| Tool | Choose when | Evidence strengths | Limits |
|---|---|---|---|
| [Appium](https://appium.io/docs/en/3.1/intro/appium/) | Cross-platform iOS/Android UI automation or device-lab parity matters. | Standard cross-platform UI automation API over real app UI and devices. | Driver/capability setup can be substantial; synchronization and flake handling need care. |
| [Maestro](https://docs.maestro.dev/) | Fast declarative mobile flows, simple install/run/assert proof, or artifact-heavy CI reporting. | Test reports, screenshots, logs, and [MP4 flow recordings](https://docs.maestro.dev/maestro-flows/workspace-management/record-your-flow). | Less suitable for deep app internals or highly custom native controls. |
| [Detox](https://wix.github.io/Detox/docs/introduction/getting-started) | React Native app where gray-box synchronization is valuable. | Device/app control and [device screenshots](https://wix.github.io/Detox/docs/19.x/api/device-object-api). | React Native-focused; setup tightly couples to app build/test configuration. |
| Native XCTest/Espresso | Platform-native correctness, OS APIs, or existing native test suites. | [XCTest attachments/screenshots](https://developer.apple.com/documentation/xctest/adding-attachments-to-tests-activities-and-issues), [Espresso user-like UI interactions](https://developer.android.com/training/testing/espresso/basics), idling resources. | Platform-specific; best with codebase familiarity and build tooling access. |

## CLI/TUI

| Tool | Choose when | Evidence strengths | Limits |
|---|---|---|---|
| [Pexpect](https://pexpect.readthedocs.io/en/stable/) / Expect-style pty automation | Interactive CLI/TUI requires prompts, keystrokes, or terminal state. | Automates spawned terminal applications and preserves transcript evidence. | Visual terminal layout needs separate screenshot/recording; ANSI timing can be flaky. |
| Shell scripts + native test runners | Command behavior is deterministic and non-interactive. | Exact commands, stdout/stderr, exit codes, files, and logs. | Not enough for TUI layout or interaction proof. |
| [Bats-core](https://bats-core.readthedocs.io/en/latest/) or language-native CLI tests | Shell command contract should become repeatable regression coverage. | Versionable test cases around exit codes/output/files. | Test output is diagnostic unless it proves the public command behavior requested. |
| [VHS](https://github.com/charmbracelet/vhs) | Reproducible terminal screenshots, frames, GIF/MP4/WebM, or a scripted visual journey is needed. | Scripted typing, waits, screenshots, frame sequences, and video. | Pair with Pexpect/Bats-style assertions; media alone is presentation, not correctness proof. |

## APIs and services

| Tool | Choose when | Evidence strengths | Limits |
|---|---|---|---|
| [Postman/Newman](https://learning.postman.com/docs/reference/newman-cli/command-line-integration-with-newman) | API proof already lives in Postman collections or stakeholders expect collection reports. | Request/response assertions, CLI runs, CI integration, custom reporters. | Not a UI proof; cloud/project data can leak if not configured carefully. |
| [Schemathesis](https://schemathesis.readthedocs.io/en/stable/) | OpenAPI/GraphQL edge cases and property-based negative coverage matter. | Schema-driven case generation with CLI/pytest integration and machine-readable reports. | Supplements rather than replaces business-journey assertions. |
| [Pact](https://docs.pact.io/) | Consumer/provider compatibility is the acceptance surface. | Contract tests for HTTP/message interactions and provider verification. | Pact docs explicitly scope it to contracts, not UI behavior or business logic. |
| [k6 browser/API](https://grafana.com/docs/k6/latest/using-k6-browser/) | Performance/load plus browser-level evidence is needed. | Browser automation through CDP, frontend performance metrics, screenshots. | Primarily a performance/load tool; not a replacement for rich UX journey proof. |
| Project-native integration tests | Repo already has service fixtures, local servers, or durable-state checks. | Fastest path to real persistence/log/API evidence. | Must still prove user-visible clients separately when the feature is user-facing. |

## Visual and accessibility support

| Tool | Choose when | Evidence strengths | Limits |
|---|---|---|---|
| Playwright screenshots/snapshots | UI has stable deterministic states and Playwright is present or acceptable. | Baseline screenshot comparison and ARIA tree snapshots. | Review changed pixels by eye; baselines can bless bad UX if not inspected. |
| [BackstopJS](https://github.com/garris/backstopjs) | Website visual regression across URLs/viewports is the main risk. | Screenshot comparison reports over time. | CSS/layout focused; dynamic state and async UI need careful stabilization. |
| [axe-core](https://github.com/dequelabs/axe-core) integrations | Automated accessibility checks should support the proof. | Web accessibility engine with Playwright, WebDriver, Puppeteer, CLI, and other integrations. | Automated a11y is partial by design; hidden/inactive regions must be activated before scanning. |
| Storybook/addon a11y/test-runner | Component states already live in Storybook. | Component-level visual/a11y checks. | Component proof does not replace full product workflow proof. |
