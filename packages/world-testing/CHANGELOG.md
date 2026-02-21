# @workflow/world-testing

## 4.1.0-beta.61

### Patch Changes

- Updated dependencies [[`c1cd9a3`](https://github.com/vercel/workflow/commit/c1cd9a3bc7a0ef953d588c8fe4f21a32f80711b3)]:
  - @workflow/core@4.1.0-beta.60
  - @workflow/cli@4.1.0-beta.60
  - workflow@4.1.0-beta.60

## 4.1.0-beta.60

### Patch Changes

- Updated dependencies [[`c75de97`](https://github.com/vercel/workflow/commit/c75de973fd41d2a1d0391d965b61210a9fb7c86c), [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277), [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277), [`14863bf`](https://github.com/vercel/workflow/commit/14863bf62210be3c43794bb5877751f6441958a5)]:
  - @workflow/core@4.1.0-beta.59
  - @workflow/world@4.1.0-beta.6
  - workflow@4.1.0-beta.59
  - @workflow/cli@4.1.0-beta.59

## 4.1.0-beta.59

### Patch Changes

- [#979](https://github.com/vercel/workflow/pull/979) [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `World.getEncryptionKeyForRun()` and thread encryption key through serialization layer

- Updated dependencies [[`0d5323c`](https://github.com/vercel/workflow/commit/0d5323c0a7e760f1fa3741cf249c19f59e9ddfbe), [`7046610`](https://github.com/vercel/workflow/commit/704661078f6d6065f9b5dcd28c0b98ae91034143), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68), [`0946dad`](https://github.com/vercel/workflow/commit/0946dad01b5db68f6a53daedb2f95c8e5beaf31c), [`c2b4fe9`](https://github.com/vercel/workflow/commit/c2b4fe9906fd0845fef646669034cd203d97a18d), [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f), [`ea3254e`](https://github.com/vercel/workflow/commit/ea3254e7ce28cef6b9b829ac7ad379921dd41ed9), [`8cfb438`](https://github.com/vercel/workflow/commit/8cfb43808b2c7fc9435cd514652baf10ad924c45), [`1c11573`](https://github.com/vercel/workflow/commit/1c1157340d88c60c7c80c0789c111050b809ab77), [`262ef3a`](https://github.com/vercel/workflow/commit/262ef3a21a223ea0047c5b2840228d3216afb2df), [`9f77380`](https://github.com/vercel/workflow/commit/9f773804937cf94fc65a2141c4a45b429771a5cb), [`852e3f1`](https://github.com/vercel/workflow/commit/852e3f1788f7a9aff638b322af4c8b1a7135c17e), [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68)]:
  - @workflow/core@4.1.0-beta.58
  - @workflow/cli@4.1.0-beta.58
  - workflow@4.1.0-beta.58
  - @workflow/world@4.1.0-beta.5

## 4.1.0-beta.58

### Patch Changes

- Updated dependencies []:
  - workflow@4.1.0-beta.57
  - @workflow/cli@4.1.0-beta.57

## 4.1.0-beta.57

### Patch Changes

- Updated dependencies [[`7653e6b`](https://github.com/vercel/workflow/commit/7653e6bfdbfe29624a5cbc1477b299f6aca3a0f0), [`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb)]:
  - @workflow/cli@4.1.0-beta.56
  - workflow@4.1.0-beta.56

## 4.1.0-beta.56

### Patch Changes

- Updated dependencies [[`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/world@4.1.0-beta.4
  - @workflow/cli@4.1.0-beta.55
  - workflow@4.1.0-beta.55

## 4.1.0-beta.55

### Patch Changes

- Updated dependencies [[`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69)]:
  - @workflow/world@4.1.0-beta.3
  - @workflow/cli@4.1.0-beta.54
  - workflow@4.1.0-beta.54

## 4.1.0-beta.54

### Patch Changes

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`fc07710`](https://github.com/vercel/workflow/commit/fc077108efa14b8c8620df5fe49db184f9fdea5d), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3)]:
  - @workflow/world@4.1.0-beta.2
  - workflow@4.1.0-beta.53
  - @workflow/cli@4.1.0-beta.53

## 4.1.0-beta.53

### Patch Changes

- Updated dependencies []:
  - @workflow/cli@4.1.0-beta.52
  - workflow@4.1.0-beta.52

## 4.1.0-beta.52

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#853](https://github.com/vercel/workflow/pull/853) [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

  This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.

- Updated dependencies [[`50f50f4`](https://github.com/vercel/workflow/commit/50f50f44d79a3cf1102173ff1865cd8a01723ea3), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8), [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`409972e`](https://github.com/vercel/workflow/commit/409972e3b478e51972e17cb1ef6057f6a5b32c47), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae)]:
  - workflow@4.1.0-beta.51
  - @workflow/world@4.1.0-beta.1
  - @workflow/cli@4.1.0-beta.51

## 4.0.1-beta.51

### Patch Changes

- Updated dependencies [[`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916)]:
  - @workflow/cli@4.0.1-beta.50
  - workflow@4.0.1-beta.50

## 4.0.1-beta.50

### Patch Changes

- Updated dependencies [[`714b233`](https://github.com/vercel/workflow/commit/714b23300561ede1532c894ae770225f260365cd)]:
  - @workflow/cli@4.0.1-beta.49
  - workflow@4.0.1-beta.49

## 4.0.1-beta.49

### Patch Changes

- Updated dependencies []:
  - @workflow/cli@4.0.1-beta.48
  - workflow@4.0.1-beta.48

## 4.0.1-beta.48

### Patch Changes

- Updated dependencies [[`abdca8f`](https://github.com/vercel/workflow/commit/abdca8fd526f3c83c7da7b96a0522f9552e2bd2f)]:
  - @workflow/cli@4.0.1-beta.47
  - workflow@4.0.1-beta.47

## 4.0.1-beta.47

### Patch Changes

- Updated dependencies [[`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290)]:
  - workflow@4.0.1-beta.46
  - @workflow/cli@4.0.1-beta.46

## 4.0.1-beta.46

### Patch Changes

- Updated dependencies [[`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66), [`44dfafe`](https://github.com/vercel/workflow/commit/44dfafe3fcf0c5aa56beb86f6d428894b22d0b0c)]:
  - @workflow/world@4.0.1-beta.13
  - @workflow/cli@4.0.1-beta.45
  - workflow@4.0.1-beta.45

## 4.0.1-beta.45

### Patch Changes

- Updated dependencies [[`3fb57e1`](https://github.com/vercel/workflow/commit/3fb57e14c8bd3948599625bdf911b88db5842320)]:
  - @workflow/cli@4.0.1-beta.44
  - workflow@4.0.1-beta.44

## 4.0.1-beta.44

### Patch Changes

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167), [`e7de61f`](https://github.com/vercel/workflow/commit/e7de61f8b88ad7c710208ef599872085fb7b6d32), [`05ecfbc`](https://github.com/vercel/workflow/commit/05ecfbcc11508defc7ccd0a8b67839eaef631e71)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/cli@4.0.1-beta.43
  - workflow@4.0.1-beta.43

## 4.0.1-beta.43

### Patch Changes

- Updated dependencies [[`01f59a3`](https://github.com/vercel/workflow/commit/01f59a3b960070e2e42804b259b6d789a9ea6789)]:
  - workflow@4.0.1-beta.42
  - @workflow/cli@4.0.1-beta.42

## 4.0.1-beta.42

### Patch Changes

- Updated dependencies [[`1a305bf`](https://github.com/vercel/workflow/commit/1a305bf91876b714699b91c6ac73bcbafde670d0)]:
  - @workflow/cli@4.0.1-beta.41
  - workflow@4.0.1-beta.41

## 4.0.1-beta.41

### Patch Changes

- [#712](https://github.com/vercel/workflow/pull/712) [`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c) Thanks [@ijjk](https://github.com/ijjk)! - Revert lazy workflow and step discovery

- Updated dependencies [[`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c)]:
  - workflow@4.0.1-beta.40
  - @workflow/cli@4.0.1-beta.40

## 4.0.1-beta.40

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.39
  - @workflow/cli@4.0.1-beta.39

## 4.0.1-beta.39

### Patch Changes

- Updated dependencies [[`80955e7`](https://github.com/vercel/workflow/commit/80955e7212b38237710249f7ac3c17fb55cae49b)]:
  - @workflow/cli@4.0.1-beta.38
  - workflow@4.0.1-beta.38

## 4.0.1-beta.38

### Patch Changes

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/world@4.0.1-beta.11
  - @workflow/cli@4.0.1-beta.37
  - workflow@4.0.1-beta.37

## 4.0.1-beta.37

### Patch Changes

- Updated dependencies [[`8ba8b6b`](https://github.com/vercel/workflow/commit/8ba8b6be6b62c549bd6743a1e5eb96feee93b4d5), [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1), [`c059cf6`](https://github.com/vercel/workflow/commit/c059cf6fcd0988b380f66dfa0f2bb85a19cc4063)]:
  - workflow@4.0.1-beta.36
  - @workflow/cli@4.0.1-beta.36

## 4.0.1-beta.36

### Patch Changes

- Updated dependencies []:
  - @workflow/cli@4.0.1-beta.35
  - workflow@4.0.1-beta.35

## 4.0.1-beta.35

### Patch Changes

- Updated dependencies []:
  - @workflow/cli@4.0.1-beta.34
  - workflow@4.0.1-beta.34

## 4.0.1-beta.34

### Patch Changes

- Updated dependencies [[`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/cli@4.0.1-beta.33
  - workflow@4.0.1-beta.33

## 4.0.1-beta.33

### Patch Changes

- Updated dependencies [[`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3)]:
  - @workflow/cli@4.0.1-beta.32
  - workflow@4.0.1-beta.32

## 4.0.1-beta.32

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.31
  - @workflow/cli@4.0.1-beta.31

## 4.0.1-beta.31

### Patch Changes

- Updated dependencies []:
  - workflow@4.0.1-beta.30
  - @workflow/cli@4.0.1-beta.30

## 4.0.1-beta.30

### Patch Changes

- Updated dependencies [[`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0), [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705)]:
  - @workflow/cli@4.0.1-beta.29
  - @workflow/world@4.0.1-beta.10
  - workflow@4.0.1-beta.29

## 4.0.1-beta.29

### Patch Changes

- Updated dependencies [57a2c32]
  - @workflow/world@4.0.1-beta.9
  - @workflow/cli@4.0.1-beta.28
  - workflow@4.0.1-beta.28

## 4.0.1-beta.28

### Patch Changes

- @workflow/cli@4.0.1-beta.27
- workflow@4.0.1-beta.27

## 4.0.1-beta.27

### Patch Changes

- workflow@4.0.1-beta.26
- @workflow/cli@4.0.1-beta.26

## 4.0.1-beta.26

### Patch Changes

- @workflow/cli@4.0.1-beta.25
- workflow@4.0.1-beta.25

## 4.0.1-beta.25

### Patch Changes

- @workflow/cli@4.0.1-beta.24
- workflow@4.0.1-beta.24

## 4.0.1-beta.24

### Patch Changes

- 8d4562e: Rename leftover references to "embedded world" to be "local world"
- Updated dependencies [1ac5592]
- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
- Updated dependencies [8d4562e]
  - workflow@4.0.1-beta.23
  - @workflow/world@4.0.1-beta.8
  - @workflow/cli@4.0.1-beta.23

## 4.0.1-beta.23

### Patch Changes

- Updated dependencies [fb9fd0f]
- Updated dependencies [6dd1750]
  - @workflow/world@4.0.1-beta.7
  - workflow@4.0.1-beta.22
  - @workflow/cli@4.0.1-beta.22

## 4.0.1-beta.22

### Patch Changes

- @workflow/cli@4.0.1-beta.21
- workflow@4.0.1-beta.21

## 4.0.1-beta.21

### Patch Changes

- @workflow/cli@4.0.1-beta.20
- workflow@4.0.1-beta.20

## 4.0.1-beta.20

### Patch Changes

- @workflow/cli@4.0.1-beta.19
- workflow@4.0.1-beta.19

## 4.0.1-beta.19

### Patch Changes

- @workflow/cli@4.0.1-beta.18
- workflow@4.0.1-beta.18

## 4.0.1-beta.18

### Patch Changes

- @workflow/cli@4.0.1-beta.17
- workflow@4.0.1-beta.17

## 4.0.1-beta.17

### Patch Changes

- @workflow/cli@4.0.1-beta.16
- workflow@4.0.1-beta.16

## 4.0.1-beta.16

### Patch Changes

- Updated dependencies [4b70739]
  - @workflow/world@4.0.1-beta.6
  - @workflow/cli@4.0.1-beta.15
  - workflow@4.0.1-beta.15

## 4.0.1-beta.15

### Patch Changes

- b97b6bf: Lock all dependencies in our packages
- Updated dependencies [b97b6bf]
- Updated dependencies [6419962]
- Updated dependencies [9335026]
- Updated dependencies [00b0bb9]
  - workflow@4.0.1-beta.14
  - @workflow/cli@4.0.1-beta.14
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.14

### Patch Changes

- Updated dependencies [11469d8]
- Updated dependencies [00efdfb]
- Updated dependencies [94d46d4]
  - @workflow/cli@4.0.1-beta.13
  - workflow@4.0.1-beta.13

## 4.0.1-beta.13

### Patch Changes

- Updated dependencies [fb8153b]
  - workflow@4.0.1-beta.12
  - @workflow/cli@4.0.1-beta.12

## 4.0.1-beta.12

### Patch Changes

- workflow@4.0.1-beta.11
- @workflow/cli@4.0.1-beta.11

## 4.0.1-beta.11

### Patch Changes

- Updated dependencies [03faac1]
- Updated dependencies [d71da4a]
  - @workflow/cli@4.0.1-beta.10
  - workflow@4.0.1-beta.10

## 4.0.1-beta.10

### Patch Changes

- Updated dependencies [4a821fc]
- Updated dependencies [8a24093]
  - @workflow/cli@4.0.1-beta.9
  - workflow@4.0.1-beta.9

## 4.0.1-beta.9

### Patch Changes

- Updated dependencies [a09a3ea]
- Updated dependencies [652485a]
- Updated dependencies [4585222]
- Updated dependencies [10bfd4a]
- Updated dependencies [5dfa4eb]
- Updated dependencies [05714f7]
- Updated dependencies [bf54a7b]
- Updated dependencies [f563585]
  - @workflow/cli@4.0.1-beta.8
  - workflow@4.0.1-beta.8

## 4.0.1-beta.8

### Patch Changes

- f973954: Update license to Apache 2.0
- Updated dependencies [f973954]
- Updated dependencies [a3326a2]
- Updated dependencies [fcadd7b]
  - workflow@4.0.1-beta.7
  - @workflow/world@4.0.1-beta.4
  - @workflow/cli@4.0.1-beta.7

## 4.0.1-beta.7

### Patch Changes

- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
  - @workflow/world@4.0.1-beta.3
  - workflow@4.0.1-beta.6
  - @workflow/cli@4.0.1-beta.6

## 4.0.1-beta.6

### Patch Changes

- Updated dependencies [0f845af]
  - @workflow/cli@4.0.1-beta.5
  - workflow@4.0.1-beta.5

## 4.0.1-beta.5

### Patch Changes

- 392c12d: Only include built files in dist in the published package

## 4.0.1-beta.4

### Patch Changes

- Updated dependencies [66332f2]
- Updated dependencies [dbf2207]
  - @workflow/cli@4.0.1-beta.4
  - workflow@4.0.1-beta.4

## 4.0.1-beta.3

### Patch Changes

- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [dfdb280]
- Updated dependencies [7dad974]
- Updated dependencies [7868434]
- Updated dependencies [d3a4ed3]
  - @workflow/world@4.0.1-beta.2
  - @workflow/cli@4.0.1-beta.3
  - workflow@4.0.1-beta.3

## 4.0.1-beta.2

### Patch Changes

- Updated dependencies [f5f171f]
  - @workflow/cli@4.0.1-beta.2
  - workflow@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [57ebfcb]
- Updated dependencies [1408293]
- Updated dependencies [cea8530]
- Updated dependencies [8196cd9]
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/cli@4.0.1-beta.1
  - workflow@4.0.1-beta.1
  - @workflow/world@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - workflow@4.0.1-beta.0
  - @workflow/world@4.0.1-beta.0
  - @workflow/cli@4.0.1-beta.0
