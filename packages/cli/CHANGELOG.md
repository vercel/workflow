# @workflow/cli

## 4.0.1-beta.47

### Patch Changes

- [#774](https://github.com/vercel/workflow/pull/774) [`abdca8f`](https://github.com/vercel/workflow/commit/abdca8fd526f3c83c7da7b96a0522f9552e2bd2f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve display of configuration information. Fix opening of Vercel backend when using `--localUi`. Fix world caching in multi-tenant environments. Fix flicker in run table when refreshing. Improve contributor experience by adding `--observabilityCwd` flag to easily iterate on web UI from another directory. Polish navbar UI.

- Updated dependencies [[`abdca8f`](https://github.com/vercel/workflow/commit/abdca8fd526f3c83c7da7b96a0522f9552e2bd2f)]:
  - @workflow/web@4.0.1-beta.28

## 4.0.1-beta.46

### Patch Changes

- Updated dependencies [[`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290), [`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290), [`a2fc53a`](https://github.com/vercel/workflow/commit/a2fc53a0dc2df0648ae9e7fd59aae044a612ebcb)]:
  - @workflow/swc-plugin@4.0.1-beta.13
  - @workflow/core@4.0.1-beta.38
  - @workflow/builders@4.0.1-beta.38
  - @workflow/web@4.0.1-beta.27

## 4.0.1-beta.45

### Patch Changes

- [#765](https://github.com/vercel/workflow/pull/765) [`44dfafe`](https://github.com/vercel/workflow/commit/44dfafe3fcf0c5aa56beb86f6d428894b22d0b0c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Read .env and .env.local files on startup

- Updated dependencies [[`adb9312`](https://github.com/vercel/workflow/commit/adb93121fc0d4790e949f79eec1c375af207bf13), [`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`3dd5b27`](https://github.com/vercel/workflow/commit/3dd5b2708de56e63c9dce9b3f2eafea63b0e3936), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66), [`49f650c`](https://github.com/vercel/workflow/commit/49f650c3a79e7b9b501cb602e3c12b75a3c4fffc), [`39e5774`](https://github.com/vercel/workflow/commit/39e5774de2a4c8b6a18574aa4edaf79e9f0d655e)]:
  - @workflow/web@4.0.1-beta.27
  - @workflow/core@4.0.1-beta.37
  - @workflow/world@4.0.1-beta.13
  - @workflow/builders@4.0.1-beta.37
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.26
  - @workflow/world-vercel@4.0.1-beta.27

## 4.0.1-beta.44

### Patch Changes

- [#747](https://github.com/vercel/workflow/pull/747) [`3fb57e1`](https://github.com/vercel/workflow/commit/3fb57e14c8bd3948599625bdf911b88db5842320) Thanks [@pranaygp](https://github.com/pranaygp)! - Use env variables instead of query params for world config (like WORKFLOW_TARGET_WORLD)

  **BREAKING CHANGE**: The OSS web UI is now locked to a single world and will not let you change world using query params

- Updated dependencies [[`3fb57e1`](https://github.com/vercel/workflow/commit/3fb57e14c8bd3948599625bdf911b88db5842320)]:
  - @workflow/web@4.0.1-beta.26

## 4.0.1-beta.43

### Patch Changes

- [#751](https://github.com/vercel/workflow/pull/751) [`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Remove the unused paused/resumed run events and states

  - Remove `run_paused` and `run_resumed` event types
  - Remove `paused` status from `WorkflowRunStatus`
  - Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
  - Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel

- [#744](https://github.com/vercel/workflow/pull/744) [`e7de61f`](https://github.com/vercel/workflow/commit/e7de61f8b88ad7c710208ef599872085fb7b6d32) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `--localUi` CLI flag to use local web UI instead of Vercel dashboard

- [#722](https://github.com/vercel/workflow/pull/722) [`05ecfbc`](https://github.com/vercel/workflow/commit/05ecfbcc11508defc7ccd0a8b67839eaef631e71) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Ensure npm pre-release version update checks work for post-GA release pre-releases

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/world-local@4.0.1-beta.25
  - @workflow/world-vercel@4.0.1-beta.26
  - @workflow/web@4.0.1-beta.25
  - @workflow/core@4.0.1-beta.36
  - @workflow/errors@4.0.1-beta.13
  - @workflow/builders@4.0.1-beta.36

## 4.0.1-beta.42

### Patch Changes

- Updated dependencies [[`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf), [`0da8e54`](https://github.com/vercel/workflow/commit/0da8e543742ad160dedc28f998cfe16fe1e3fd84), [`8bc4e5f`](https://github.com/vercel/workflow/commit/8bc4e5fe3ccd67ccdd39737d3d30ad4268215a27), [`505063c`](https://github.com/vercel/workflow/commit/505063cbb9ef04af8531c2cd3cd3840b5d272f82), [`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf)]:
  - @workflow/builders@4.0.1-beta.35
  - @workflow/web@4.0.1-beta.24
  - @workflow/core@4.0.1-beta.35

## 4.0.1-beta.41

### Patch Changes

- [#701](https://github.com/vercel/workflow/pull/701) [`1a305bf`](https://github.com/vercel/workflow/commit/1a305bf91876b714699b91c6ac73bcbafde670d0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Display a notice when using an outdated version of the workflow package

- Updated dependencies [[`d552374`](https://github.com/vercel/workflow/commit/d552374b13945c76cbffccfcfdef38f4e3b5a97c)]:
  - @workflow/builders@4.0.1-beta.34

## 4.0.1-beta.40

### Patch Changes

- Updated dependencies [[`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2), [`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c), [`7ff68d1`](https://github.com/vercel/workflow/commit/7ff68d1753c43b14d161d249f6745de6beddd99b)]:
  - @workflow/core@4.0.1-beta.34
  - @workflow/web@4.0.1-beta.23
  - @workflow/utils@4.0.1-beta.10
  - @workflow/builders@4.0.1-beta.33
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.24
  - @workflow/world-vercel@4.0.1-beta.25

## 4.0.1-beta.39

### Patch Changes

- Updated dependencies [[`2dbe494`](https://github.com/vercel/workflow/commit/2dbe49495dd4fae22edc53e190952c8f15289b8b)]:
  - @workflow/world-local@4.0.1-beta.23
  - @workflow/core@4.0.1-beta.33
  - @workflow/builders@4.0.1-beta.32
  - @workflow/web@4.0.1-beta.22

## 4.0.1-beta.38

### Patch Changes

- [#684](https://github.com/vercel/workflow/pull/684) [`80955e7`](https://github.com/vercel/workflow/commit/80955e7212b38237710249f7ac3c17fb55cae49b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow opening UI without a valid local config detected, UI will show warning and watch folder

- Updated dependencies [[`f989613`](https://github.com/vercel/workflow/commit/f989613d7020f987fba2c74f2e49c8d47ff74a29)]:
  - @workflow/web@4.0.1-beta.22

## 4.0.1-beta.37

### Patch Changes

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/world-local@4.0.1-beta.22
  - @workflow/builders@4.0.1-beta.31
  - @workflow/utils@4.0.1-beta.9
  - @workflow/world@4.0.1-beta.11
  - @workflow/core@4.0.1-beta.32
  - @workflow/web@4.0.1-beta.21
  - @workflow/errors@4.0.1-beta.12
  - @workflow/world-vercel@4.0.1-beta.24

## 4.0.1-beta.36

### Patch Changes

- [#682](https://github.com/vercel/workflow/pull/682) [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Extract helper to find local world dataDir across CLI/web projects

- [#669](https://github.com/vercel/workflow/pull/669) [`c059cf6`](https://github.com/vercel/workflow/commit/c059cf6fcd0988b380f66dfa0f2bb85a19cc4063) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add -i / --interactive flag for enabling pagination bindings, new default being off

- Updated dependencies [[`d9f6a49`](https://github.com/vercel/workflow/commit/d9f6a4939760be94dfc9eaf77dcaa48c602c18ef), [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1), [`4bc98ff`](https://github.com/vercel/workflow/commit/4bc98ff4a15a090e2233c18b75e0a1b5dd2e9ff1), [`ea3afce`](https://github.com/vercel/workflow/commit/ea3afce222ff9c2f90d99414fae275ef5f54b431), [`25b02b0`](https://github.com/vercel/workflow/commit/25b02b0bfdefa499e13fb974b1832fbe47dbde86), [`c3464bf`](https://github.com/vercel/workflow/commit/c3464bfd978a073f6d8fca95208bd053aa5c78dd)]:
  - @workflow/world-local@4.0.1-beta.21
  - @workflow/utils@4.0.1-beta.8
  - @workflow/web@4.0.1-beta.20
  - @workflow/builders@4.0.1-beta.30
  - @workflow/core@4.0.1-beta.31
  - @workflow/errors@4.0.1-beta.11
  - @workflow/world-vercel@4.0.1-beta.23

## 4.0.1-beta.35

### Patch Changes

- Updated dependencies [[`ef22f82`](https://github.com/vercel/workflow/commit/ef22f82c9ead53744bac23fa12ed6bfbb1aba0bb), [`f2d5997`](https://github.com/vercel/workflow/commit/f2d5997b800d6c474bb93d4ddd82cf52489752da)]:
  - @workflow/web@4.0.1-beta.19
  - @workflow/world-local@4.0.1-beta.20
  - @workflow/core@4.0.1-beta.30
  - @workflow/builders@4.0.1-beta.29

## 4.0.1-beta.34

### Patch Changes

- Updated dependencies [[`f396833`](https://github.com/vercel/workflow/commit/f39683370dc187273bd8aa5108e11e49dffe027a), [`eaf9aa6`](https://github.com/vercel/workflow/commit/eaf9aa65f354bf1e22e8e148c0fd1936f0ec9358), [`75a5060`](https://github.com/vercel/workflow/commit/75a506047304f6dd1ac07d9150e8a9563f69283c), [`6cd1a47`](https://github.com/vercel/workflow/commit/6cd1a47b3146770f5cb9d4c384971331aab6b28a)]:
  - @workflow/web@4.0.1-beta.18
  - @workflow/core@4.0.1-beta.29
  - @workflow/world-vercel@4.0.1-beta.22
  - @workflow/builders@4.0.1-beta.28

## 4.0.1-beta.33

### Patch Changes

- [#638](https://github.com/vercel/workflow/pull/638) [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Move auth error messages into @workflow/errors package

- Updated dependencies [[`ea2a67e`](https://github.com/vercel/workflow/commit/ea2a67e19c5d224b4b4fd1c1a417810562df0807), [`ce7d428`](https://github.com/vercel/workflow/commit/ce7d428a07cd415d2ea64c779b84ecdc796927a0), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`ab55ba2`](https://github.com/vercel/workflow/commit/ab55ba2d61b41e2b2cd9e213069c93be988c9b1e), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/core@4.0.1-beta.28
  - @workflow/world-local@4.0.1-beta.19
  - @workflow/world-vercel@4.0.1-beta.21
  - @workflow/errors@4.0.1-beta.10
  - @workflow/builders@4.0.1-beta.27
  - @workflow/web@4.0.1-beta.17

## 4.0.1-beta.32

### Patch Changes

- [#627](https://github.com/vercel/workflow/pull/627) [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - [world-vercel] Allow skipping vercel backend proxy for e2e tests where CLI runs in runtime env

- Updated dependencies [[`05ea678`](https://github.com/vercel/workflow/commit/05ea6789e5773d5b4ee16dce4a800e613261f452), [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3), [`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240), [`4d7a393`](https://github.com/vercel/workflow/commit/4d7a393906846be751e798c943594bec3c9b0ff3)]:
  - @workflow/web@4.0.1-beta.17
  - @workflow/world-vercel@4.0.1-beta.20
  - @workflow/core@4.0.1-beta.27
  - @workflow/errors@4.0.1-beta.9
  - @workflow/world-local@4.0.1-beta.18
  - @workflow/builders@4.0.1-beta.26

## 4.0.1-beta.31

### Patch Changes

- Updated dependencies [[`6265534`](https://github.com/vercel/workflow/commit/6265534d6be2cba54265ef23b94a0810d9e25c9c)]:
  - @workflow/web@4.0.1-beta.16

## 4.0.1-beta.30

### Patch Changes

- Updated dependencies [[`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a), [`696e7e3`](https://github.com/vercel/workflow/commit/696e7e31e88eae5d86e9d4b9f0344f0777ae9673)]:
  - @workflow/world-local@4.0.1-beta.17
  - @workflow/core@4.0.1-beta.26
  - @workflow/web@4.0.1-beta.15
  - @workflow/errors@4.0.1-beta.8
  - @workflow/builders@4.0.1-beta.25
  - @workflow/world-vercel@4.0.1-beta.19

## 4.0.1-beta.29

### Patch Changes

- [#575](https://github.com/vercel/workflow/pull/575) [`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add Web and CLI UI for listing and viewing streams

- Updated dependencies [[`19c271c`](https://github.com/vercel/workflow/commit/19c271c0725f263ebbcbd87e68240547c1acbe2f), [`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0), [`d42a968`](https://github.com/vercel/workflow/commit/d42a9681a1c7139ac5ed2973b1738d8a9000a1b6), [`33c254c`](https://github.com/vercel/workflow/commit/33c254c82c1c452300d6bff531c33329aa01d4ec), [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705), [`0bbd26f`](https://github.com/vercel/workflow/commit/0bbd26f8c85a04dea3dc87a11c52e9ac63a18e84), [`c35b445`](https://github.com/vercel/workflow/commit/c35b4458753cc116b90d61f470f7ab1d964e8a1e), [`d3fd81d`](https://github.com/vercel/workflow/commit/d3fd81dffd87abbd1a3d8a8e91e9781959eefd40), [`058757c`](https://github.com/vercel/workflow/commit/058757c476579a7b1bb6a8ba9a3d15f57b30c898)]:
  - @workflow/builders@4.0.1-beta.24
  - @workflow/core@4.0.1-beta.25
  - @workflow/web@4.0.1-beta.15
  - @workflow/world-local@4.0.1-beta.16
  - @workflow/world-vercel@4.0.1-beta.18
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.28

### Patch Changes

- 57a2c32: Add expiredAt attribute to Run
- Updated dependencies [48b3a12]
- Updated dependencies [57a2c32]
- Updated dependencies [14daedd]
- Updated dependencies [fc774e5]
- Updated dependencies [4aecb99]
- Updated dependencies [24e6271]
- Updated dependencies [21cff15]
- Updated dependencies [fa37d26]
- Updated dependencies [f46c51e]
- Updated dependencies [8172455]
- Updated dependencies [af5b005]
- Updated dependencies [43f2dec]
  - @workflow/world-local@4.0.1-beta.15
  - @workflow/world@4.0.1-beta.9
  - @workflow/web@4.0.1-beta.14
  - @workflow/builders@4.0.1-beta.23
  - @workflow/swc-plugin@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.24
  - @workflow/errors@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.17

## 4.0.1-beta.27

### Patch Changes

- Updated dependencies [ca27c0f]
  - @workflow/web@4.0.1-beta.13

## 4.0.1-beta.26

### Patch Changes

- Updated dependencies [c8fa70a]
  - @workflow/world-vercel@4.0.1-beta.16
  - @workflow/core@4.0.1-beta.23
  - @workflow/builders@4.0.1-beta.22
  - @workflow/web@4.0.1-beta.12

## 4.0.1-beta.25

### Patch Changes

- Updated dependencies [ac7997b]
- Updated dependencies [02c41cc]
  - @workflow/swc-plugin@4.0.1-beta.11
  - @workflow/builders@4.0.1-beta.21
  - @workflow/core@4.0.1-beta.22
  - @workflow/web@4.0.1-beta.12

## 4.0.1-beta.24

### Patch Changes

- Updated dependencies [2f0840b]
- Updated dependencies [555d7a6]
- Updated dependencies [e9494d5]
  - @workflow/core@4.0.1-beta.21
  - @workflow/swc-plugin@4.0.1-beta.10
  - @workflow/world-vercel@4.0.1-beta.15
  - @workflow/builders@4.0.1-beta.20
  - @workflow/web@4.0.1-beta.12

## 4.0.1-beta.23

### Patch Changes

- 8d4562e: Rename leftover references to "embedded world" to be "local world"
- Updated dependencies [d53bf90]
- Updated dependencies [0f1645b]
- Updated dependencies [3c19e90]
- Updated dependencies [1ac5592]
- Updated dependencies [6e8e828]
- Updated dependencies [5b91861]
- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
- Updated dependencies [109fe59]
- Updated dependencies [0cacb99]
- Updated dependencies [2faddf3]
- Updated dependencies [10c5b91]
- Updated dependencies [8d4562e]
  - @workflow/builders@4.0.1-beta.19
  - @workflow/core@4.0.1-beta.20
  - @workflow/world-local@4.0.1-beta.14
  - @workflow/swc-plugin@4.0.1-beta.9
  - @workflow/world@4.0.1-beta.8
  - @workflow/web@4.0.1-beta.12
  - @workflow/errors@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.14

## 4.0.1-beta.22

### Patch Changes

- Updated dependencies [07800c2]
- Updated dependencies [fb9fd0f]
- Updated dependencies [b042ba7]
- Updated dependencies [8b470f0]
- Updated dependencies [40057db]
  - @workflow/core@4.0.1-beta.19
  - @workflow/swc-plugin@4.0.1-beta.8
  - @workflow/world@4.0.1-beta.7
  - @workflow/builders@4.0.1-beta.18
  - @workflow/world-local@4.0.1-beta.13
  - @workflow/web@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.6
  - @workflow/world-vercel@4.0.1-beta.13

## 4.0.1-beta.21

### Patch Changes

- Updated dependencies [6889dac]
  - @workflow/world-vercel@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.18
  - @workflow/builders@4.0.1-beta.17
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.20

### Patch Changes

- Updated dependencies [2c438c3]
- Updated dependencies [edb69c3]
  - @workflow/world-vercel@4.0.1-beta.11
  - @workflow/world-local@4.0.1-beta.12
  - @workflow/core@4.0.1-beta.17
  - @workflow/errors@4.0.1-beta.6
  - @workflow/builders@4.0.1-beta.16
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.19

### Patch Changes

- Updated dependencies [3436629]
- Updated dependencies [9961140]
- Updated dependencies [73b6c68]
  - @workflow/core@4.0.1-beta.16
  - @workflow/world-local@4.0.1-beta.11
  - @workflow/builders@4.0.1-beta.15
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.18

### Patch Changes

- Updated dependencies [e5c5236]
  - @workflow/swc-plugin@4.0.1-beta.7
  - @workflow/builders@4.0.1-beta.14

## 4.0.1-beta.17

### Patch Changes

- Updated dependencies [3d99d6d]
  - @workflow/world-vercel@4.0.1-beta.10
  - @workflow/world-local@5.0.0-beta.10
  - @workflow/core@4.0.1-beta.15
  - @workflow/builders@4.0.1-beta.13
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.16

### Patch Changes

- Updated dependencies [6e41c90]
  - @workflow/core@4.0.1-beta.14
  - @workflow/builders@4.0.1-beta.12
  - @workflow/web@4.0.1-beta.11

## 4.0.1-beta.15

### Patch Changes

- Updated dependencies [2fde24e]
- Updated dependencies [4b70739]
  - @workflow/core@4.0.1-beta.13
  - @workflow/world-vercel@4.0.1-beta.9
  - @workflow/world-local@5.0.0-beta.9
  - @workflow/world@4.0.1-beta.6
  - @workflow/builders@4.0.1-beta.11
  - @workflow/web@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.5

## 4.0.1-beta.14

### Patch Changes

- b97b6bf: Lock all dependencies in our packages
- Updated dependencies [aa015af]
- Updated dependencies [00b0bb9]
- Updated dependencies [5eb588a]
- Updated dependencies [00b0bb9]
- Updated dependencies [0b848cd]
- Updated dependencies [85ce8e0]
- Updated dependencies [8e96134]
- Updated dependencies [b97b6bf]
- Updated dependencies [45b7b41]
- Updated dependencies [00b0bb9]
- Updated dependencies [f8e5d10]
- Updated dependencies [6be03f3]
- Updated dependencies [8002e0f]
- Updated dependencies [f07b2da]
- Updated dependencies [00b0bb9]
- Updated dependencies [00b0bb9]
- Updated dependencies [79480f2]
- Updated dependencies [aecdcdf]
  - @workflow/world-local@5.0.0-beta.8
  - @workflow/swc-plugin@4.0.1-beta.6
  - @workflow/core@4.0.1-beta.12
  - @workflow/builders@4.0.1-beta.10
  - @workflow/world-vercel@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.5
  - @workflow/web@4.0.1-beta.11
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.13

### Patch Changes

- 11469d8: Update default fallback path for connecting to local world
- 00efdfb: Fix --noBrowser option help documentation
- Updated dependencies [8208b53]
- Updated dependencies [2b880f9]
- Updated dependencies [11469d8]
- Updated dependencies [4f9ae4e]
- Updated dependencies [2dca0d4]
- Updated dependencies [aac1b6c]
- Updated dependencies [6373ab5]
- Updated dependencies [68363b2]
- Updated dependencies [00efdfb]
  - @workflow/builders@4.0.1-beta.9
  - @workflow/core@4.0.1-beta.11
  - @workflow/world-local@4.0.1-beta.7
  - @workflow/web@4.0.1-beta.10
  - @workflow/swc-plugin@4.0.1-beta.5
  - @workflow/world-vercel@4.0.1-beta.7

## 4.0.1-beta.12

### Patch Changes

- Updated dependencies [7013f29]
- Updated dependencies [a28bc37]
- Updated dependencies [e0c6618]
- Updated dependencies [809e0fe]
- Updated dependencies [adf0cfe]
- Updated dependencies [5c0268b]
- Updated dependencies [0b3e89e]
- Updated dependencies [7a47eb8]
  - @workflow/core@4.0.1-beta.10
  - @workflow/swc-plugin@4.0.1-beta.4
  - @workflow/world-local@4.0.1-beta.6
  - @workflow/web@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.4
  - @workflow/builders@4.0.1-beta.8
  - @workflow/world-vercel@4.0.1-beta.6

## 4.0.1-beta.11

### Patch Changes

- Updated dependencies [9f56434]
  - @workflow/core@4.0.1-beta.9
  - @workflow/web@4.0.1-beta.8
  - @workflow/builders@4.0.1-beta.7

## 4.0.1-beta.10

### Patch Changes

- 03faac1: Fix CLI `--web` flag on Windows
- d71da4a: Update "alpha" text in CLI help to "beta"
- Updated dependencies [c2fa9df]
  - @workflow/builders@4.0.1-beta.6
  - @workflow/web@4.0.1-beta.8

## 4.0.1-beta.9

### Patch Changes

- 4a821fc: Fix Windows path handling by normalizing backslashes to forward slashes in workflow IDs
- Updated dependencies [4a821fc]
- Updated dependencies [4a821fc]
  - @workflow/swc-plugin@4.0.1-beta.3
  - @workflow/builders@4.0.1-beta.5
  - @workflow/core@4.0.1-beta.8
  - @workflow/web@4.0.1-beta.8

## 4.0.1-beta.8

### Patch Changes

- a09a3ea: Remove unused builder code from CLI
- 652485a: Create @workflow/builders package with shared builder infrastructure
- 4585222: Deduplicate package.json and .vc-config.json generation
- 10bfd4a: Extract path resolution and directory creation helpers
- 5dfa4eb: Extract queue trigger configuration constants
- 05714f7: Add sveltekit workflow integration
- bf54a7b: Standardize method naming conventions
- Updated dependencies [80d68b7]
- Updated dependencies [744d82f]
- Updated dependencies [ebee7f5]
- Updated dependencies [652485a]
- Updated dependencies [4585222]
- Updated dependencies [10bfd4a]
- Updated dependencies [5dfa4eb]
- Updated dependencies [05714f7]
- Updated dependencies [f8c779e]
- Updated dependencies [bf54a7b]
- Updated dependencies [7db9e94]
  - @workflow/builders@4.0.1-beta.4
  - @workflow/world-local@4.0.1-beta.5
  - @workflow/core@4.0.1-beta.7
  - @workflow/web@4.0.1-beta.8

## 4.0.1-beta.7

### Patch Changes

- f973954: Update license to Apache 2.0
- a3326a2: Add `workflow inspect sleep` command to list active sleep/wait events
- Updated dependencies [10309c3]
- Updated dependencies [2ae7426]
- Updated dependencies [10309c3]
- Updated dependencies [f973954]
- Updated dependencies [2ae7426]
  - @workflow/core@4.0.1-beta.6
  - @workflow/web@4.0.1-beta.7
  - @workflow/world-local@4.0.1-beta.4
  - @workflow/swc-plugin@4.0.1-beta.2
  - @workflow/world-vercel@4.0.1-beta.5
  - @workflow/errors@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.4

## 4.0.1-beta.6

### Patch Changes

- Updated dependencies [20d51f0]
- Updated dependencies [796fafd]
- Updated dependencies [8f63385]
- Updated dependencies [796fafd]
- Updated dependencies [20d51f0]
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
- Updated dependencies [20d51f0]
- Updated dependencies [55e2d0b]
  - @workflow/world-vercel@4.0.1-beta.4
  - @workflow/core@4.0.1-beta.5
  - @workflow/web@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.3

## 4.0.1-beta.5

### Patch Changes

- 0f845af: Alias workflow web to workflow inspect runs --web, hide trace viewer search for small runs
- Updated dependencies [6504e42]
- Updated dependencies [0f845af]
- Updated dependencies [e367046]
- Updated dependencies [ffb7af3]
  - @workflow/core@4.0.1-beta.4
  - @workflow/web@4.0.1-beta.5
  - @workflow/world-vercel@4.0.1-beta.3

## 4.0.1-beta.4

### Patch Changes

- 66332f2: Rename vercel-static builder to standalone
- dbf2207: Fix --backend flag not finding world when using local world package name explicitly
- Updated dependencies [dbf2207]
- Updated dependencies [eadf588]
  - @workflow/web@4.0.1-beta.4

## 4.0.1-beta.3

### Patch Changes

- dfdb280: Generate the webhook route in the static builder mode
- d3a4ed3: Move `@types/watchpack` to be a devDependency
- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [66225bf]
- Updated dependencies [7868434]
- Updated dependencies [731adff]
- Updated dependencies [57419e5]
- Updated dependencies [22917ab]
- Updated dependencies [66225bf]
- Updated dependencies [9ba86ce]
  - @workflow/world@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.2
  - @workflow/world-vercel@4.0.1-beta.2
  - @workflow/web@4.0.1-beta.3
  - @workflow/core@4.0.1-beta.3

## 4.0.1-beta.2

### Patch Changes

- f5f171f: Fine tune CLI output table width for smaller displays
- Updated dependencies [f5f171f]
- Updated dependencies [854feb4]
- Updated dependencies [f1c6bc5]
  - @workflow/web@4.0.1-beta.2
  - @workflow/core@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- 57ebfcb: CLI: Allow using package names instead of alias names for --backend flag
- 1408293: Add "description" field to `package.json` file
- 8196cd9: Allow specifying vercel world package name as an alias for "vercel"
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [57ebfcb]
- Updated dependencies [1408293]
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/core@4.0.1-beta.1
  - @workflow/swc-plugin@4.0.1-beta.1
  - @workflow/world-vercel@4.0.1-beta.1
  - @workflow/world-local@4.0.1-beta.1
  - @workflow/errors@4.0.1-beta.1
  - @workflow/world@4.0.1-beta.1
  - @workflow/web@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - @workflow/swc-plugin@4.0.1-beta.0
  - @workflow/world-vercel@4.0.1-beta.0
  - @workflow/world-local@4.0.1-beta.0
  - @workflow/errors@4.0.1-beta.0
  - @workflow/world@4.0.1-beta.0
  - @workflow/core@4.0.1-beta.0
  - @workflow/web@4.0.1-beta.0
