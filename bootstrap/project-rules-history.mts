// OP-1425. Identities of every claude/CLAUDE.project.md and claude/AGENTS.project.md
// ever committed before the installer switched to a marked block. Installers up
// to that point copied these templates whole over $WS/CLAUDE.md and $WS/AGENTS.md,
// so a workspace file that still equals one of them was never edited by the
// operator and may be replaced by the block. Any other unmarked file is operator
// content and is kept byte for byte.
//
// sha256 of the blob with CRLF folded to LF, because a CRLF checkout of the same
// template is the same template. Generated once from all refs, including the
// pre-public history that main no longer carries:
//   git rev-list --objects --all --until=2026-09-24T00:00:00Z -- \
//     claude/CLAUDE.project.md claude/AGENTS.project.md
// The set also includes public v0.1.0 (226c6d3), which installed whole files after
// that cutoff. v0.1.1 (2c9d519) already installed marked blocks, so its reference
// templates need no hashes. The coverage test first selects pre-cutoff commits,
// adds the v0.1.0 commit, then walks only their objects: --objects --all alone can
// include non-commit refs such as archived trees despite --until. The set is frozen.
export const KNOWN_TEMPLATE_SHA256: readonly string[] = Object.freeze([
  "0c0db7e72330d7d9a14569593f44572fecf7ba380b110241ef541a6ae7e08e41", // 306 lines
  "0cf293aaafa44a4331b73f4cf92c6c7e0f4591534acf8c705c0db72089982e66", // 332 lines
  "129702b0cdb241f5fbd4012ddc28aec76cf3ef2f037bc58b94980bc39b15aa63", // 368 lines
  "14411acc91cf17c0dbb28cd01ba7da1662b63d0b2106c547c92e5eb40b8f2d4a", // 307 lines
  "1f0d4eb34f4ec355031637a0043c0a35ad8be26ca26f1ebfe49a9546b5b9f541", // 371 lines
  "22f53a13da5bf82f6ac25101461a74c9d1b016e803ae81d6a8cfebe8f7a53fb3", // 409 lines
  "245c8acbabefe45b0f06371ff86d6c1cb32c9759606c53c04410ddde3ebe0f94", // 409 lines
  "2a1f4998f69770b27e821a23bca0ee31363c3251febc8979829a894e4f9c123d", // 399 lines
  "2b662a155024e3f5472bd539a54d8a94d453fcc0d72f9fbb4d6da54a9f006507", // 392 lines
  "2c19a918fa6a749d54d4671605c46d262c0822d94f9f53d4a96792cf58c50f8f", // 382 lines
  "341f82bf185bcfcdaef75dc794f6f7d58ae32b1d08f239a7c7e850dbdc4af75f", // 375 lines
  "49050d01dc53a7b071cedc31ea7ee0ed6405510bf3ced43fce8d98c20be144eb", // 399 lines
  "4e6b59ecedd4f4ec2b0d97df2581007ca95f39a3a33360154f8032bd77e2dcec", // 340 lines
  "590515d840027f6b4e797fba9ef2e850c0c90b476171a78a21e194abdfc0d3e5", // 399 lines
  "599af75e4890bb0b2bb5d5e702754d8e4d99c61ec818c96a503f435bd36c95a3", // 385 lines
  "6d55f764c7b05992c6baf3bc66395bebbae3b33246a49a57286b9e7c06dfd6fd", // 409 lines
  "6e2d89d51367471cf9d9901d833bdb6709a664533f3dcd7997ad28917fec12af", // 307 lines
  "7e0548eb60c464f5eea90d64c7dc7bb3a5de6bf8d9e542a3ec8c2a2c744605a9", // 399 lines
  "82a76640de7f3f3248e9fea7711930d3f455de2bb654ff31249c50b35fcb7e04", // 399 lines
  "9c7b2e1e2338ce9f3993206e3122f2223d1fe56955a464b34103ddf731e7e372", // 269 lines
  "9ecfd83b5b8e41310d82df2df011b53c1f3054b9c518b9226a7fefd27cf62835", // 37 lines
  "a1d431745ca64b9552cbbed4c1852c47ddf40f1a15ea4753a85aba60090ecff9", // 409 lines
  "a31f255ad6b8f526b9d6ebf00a026072f4e10fbca10952d59a88da3bd0802840", // 41 lines
  "b0a0b19ea28c4269c1539575fcc72f6053d0d7a57f50cc97addb3ad4d4757d0d", // 409 lines
  "b368bb3e2612f40a50426b400b7d518938d0327191b294d8bbc5bb33ac0bc2b2", // 361 lines
  "cc521baf4818210e16add676168aad36c2d17c02f534244feebdb411f293df5d", // 352 lines
  "d030cdd64f1b3ae0a387aa674f445360360270540767ce4d50a5cb5a253c2415", // 345 lines
  "d0e98d37c69060f045f845082c67cb75bf148e0c407b408860b8ebebc4d038dd", // 307 lines
  "dbd3b8a30370eb653e1ed9164c2e28cce90151603aacc3502f281bc4d1773601", // 342 lines
  "dcc44ebb8f837971e6fa6d7160ebfef99cbec0fc465baceb99d5358ed90528f0", // 307 lines
  "ee728d3ea89cf5e4bf8e20e6b0288256f1fd4c645f602721eb2c0e5c3b9870a0", // 402 lines
]);
