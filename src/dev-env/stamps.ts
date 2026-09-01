/**
 * The built-in stamps (D10) and their vocabulary.
 *
 * D10 says stamping is a CONTRACT, not a technology: instantiate(id, scope,
 * config) · readiness · teardown = delete the scope. The generic app stamp is
 * the smallest thing that satisfies it — an image, a port, some env — and it is
 * what a deployment gets before anyone writes a Helm chart or a recipe release.
 *
 * Everything here is pure. A stamp is a description; rendering turns it into
 * manifests. WHERE those manifests land is the driver's business (the k8s
 * driver applies them inside the instance's own child cluster), and a driver
 * that realizes apps some other way reads the same `AppStampSpec` and renders
 * its own thing.
 */
import {
  DEV_TREE_GID_TOKEN,
  DEV_TREE_PVC,
  DEV_TREE_STORAGE_CLASS,
  DEV_TREE_UID_TOKEN,
  isDevManifests,
  type DevTreeIdentity,
  type StampDevApp,
  type StampDevConsumer,
  type StampDevSpec,
} from './dev-tree.js';
import {
  NANOCLAW_CHILD_MANIFESTS,
  NANOCLAW_DEV_CHILD_MANIFESTS,
  NANOCLAW_HOST_DEPLOYMENT,
  NANOCLAW_NAMESPACE,
} from './nanoclaw-child-manifests.js';

export interface AppStampSpec {
  /**
   * The image, and — with `presence` — WHERE it comes from (C15).
   *
   * The default reading is the pull path: a FULLY QUALIFIED registry ref
   * (explicit registry host) that the platform resolves to a digest at the
   * approved write and PLACES onto the node before the stamp becomes
   * claimable. An unqualified ref is refused at create: CRI normalization
   * turns `org/app` into `docker.io/org/app`, a registerable Docker Hub org,
   * so an unqualified ref is a squatter's delivery path wearing a
   * private-looking name.
   */
  image: string;
  /**
   * `'node-local'` is the explicit opt-out (air-gapped installs, platform
   * images that ride the pinned instance bundle): the platform assumes the
   * image is already in the node's store — no placement rows, no claim gate,
   * and the claim finds it or does not. It is the operator-hands path with
   * the claim/import race (#22) fully intact, which is why it must be CHOSEN
   * and is never defaulted into. Absent = `'registry'`, the pull path.
   */
  presence?: 'registry' | 'node-local';
  /**
   * Names — by NAME only — a registry credential the install holds for a
   * private origin. Custody holds the value (ruling 3: the same governed
   * custody sandbox git rides — no standing creds in platform namespaces);
   * nothing here or downstream ever carries it.
   */
  imageCredential?: string;
  /** The port the app serves on; also what readiness probes. */
  port: number;
  env?: Record<string, string>;
  /** Overrides the image's entrypoint when set. */
  command?: string[];
}

/**
 * The build origin (C15's rarer path): a Dockerfile and no published image.
 * PARSED and grammar-checked so an authored build block earns its structural
 * refusals in front of the author — but registration is refused wholesale in
 * v1 (see validateStampEntry): no installed driver declares `imageBuild`, and
 * an origin nothing can realize must be refused at create, never discovered
 * as a claim that waits out a boot budget.
 */
export interface StampBuildSpec {
  /** Repo-relative Dockerfile path; `..` and absolute paths refused. */
  dockerfile?: string;
  target?: string;
  /** Build args — grammar-checked: they ride argv wherever a driver invokes its builder. */
  args?: Record<string, string>;
}

/** The Deployment whose Available condition IS a childManifests stamp's readiness. */
export interface StampReadiness {
  deployment: string;
  namespace: string;
}

/**
 * The per-instance identity token (C3): substituted at EVERY `childManifests`
 * apply with the child's parent-side namespace name — unique per instance,
 * allocated at pool fill, and stable for the slot's whole life. It is the only
 * identity seed that exists before a claimant does, which is what makes a
 * per-instance identity compatible with a warm pool at all.
 *
 * A stream authors its own identity env entries — `{"name": "ORG_ID", "value":
 * "org-${INSTANCE}"}`, `{"name": "INSTALL_ID", "value": "${INSTANCE}"}` — so no
 * identity logic enters the driver, and `refuseInheritedIdentity` below is what
 * stops a stream from writing those as literals instead. The JSON spelling is
 * the one that matters: a stream naming an identity key must parse as JSON
 * documents or the refusal cannot read it (see refuseInheritedIdentity), and
 * `STAMP_IDENTITY_EXAMPLE` is the exact form the operator docs show.
 */
export const INSTANCE_TOKEN = '${INSTANCE}';

/**
 * The identity env entries the operator docs tell an author to copy, VERBATIM —
 * `skills/dev-env/SKILL.md` and the `stamp-author` skill both show this text,
 * and `ci/tests/dev-env-stamp-docs.test.ts` fails if either stops.
 *
 * It lives in code so a test can push it through `validateStampEntry` as well:
 * a documented example the flagship refusal REJECTS is worse than no example,
 * and the pair of tests is the only arrangement in which the doc and the
 * validator cannot drift apart. Written as a plain string, not a template, so
 * the doc test can read it out of the source text.
 */
export const STAMP_IDENTITY_EXAMPLE =
  '{"name": "ORG_ID", "value": "org-${INSTANCE}"},\n{"name": "INSTALL_ID", "value": "${INSTANCE}"}';

/**
 * What an installation-identity env key LOOKS like — `ORG_ID`, `INSTALL_ID`,
 * `INSTALLATION_ID`, and every component-prefixed spelling of them
 * (`<COMPONENT>_ORG_ID`, `<COMPONENT>_GW_ORG_ID`, …).
 *
 * Two things that share these values ARE one installation to the components
 * that read them — a gateway accepts only a bundle whose org matches, a
 * governance plane rejects an audit batch naming a different installation — so
 * this pattern is the mechanical form of "a claimed child is its own
 * installation".
 *
 * A SHAPE and not a list of names, for two reasons. The platform is
 * tenant-generic and may not carry a vendor's variable names (D9). And a list
 * is exactly the thing a second component's spelling walks past: a stream that
 * set only `<GOVERNANCE>_ORG_ID` would carry the parent's org into the child
 * while passing a check that only knew `ORG_ID`.
 *
 * It over-matches on purpose — a FOREIGN org id under an identity-shaped name
 * (a directory provider's org, say) is refused too. That is the conservative
 * direction here and it is declared in SKILL.md: carry a foreign id under a
 * name that is not identity-shaped.
 */
const IDENTITY_ENV_KEY_RE = /^([A-Z][A-Z0-9]*_)*(ORG|INSTALL|INSTALLATION)_ID$/;

/** The same shape, unanchored — the cheap "does this stream talk about identity at all" pre-check. */
const IDENTITY_MENTION_RE = /\b([A-Z][A-Z0-9]*_)*(ORG|INSTALL|INSTALLATION)_ID\b/;

/** Does this env/data key name an installation identity? See IDENTITY_ENV_KEY_RE. */
export function isIdentityEnvKey(key: string): boolean {
  return IDENTITY_ENV_KEY_RE.test(key);
}

/**
 * Resolve `${INSTANCE}` against the instance's namespace name. Applied to the
 * whole stream unconditionally — a stamp that never writes the token is
 * unchanged, and one that does gets the same answer on every re-apply, which
 * is what keeps converge-then-probe idempotent.
 */
export function substituteInstance(stream: string, instance: string): string {
  return stream.replaceAll(INSTANCE_TOKEN, instance);
}

/**
 * What one stamp deploys inside its instance — the k8s driver's stamp
 * vocabulary (D10's config argument).
 *
 * `app` is the generic app stamp above, converge-then-probed on the
 * stampId-named Deployment. `childManifests` is the raw seam (T5): a manifest
 * stream applied as-is inside the booted child cluster, carrying its own
 * names — which is exactly why it MUST declare `readiness`. The driver does
 * not interpret the stream, so it cannot infer what "up" means for it, and a
 * childManifests stamp without a gate would go warm on a bare vcluster —
 * the silent failure the construction-time refusal exists for. Neither field
 * set = a bare vcluster, which is a legal stamp.
 */
export interface K8sStampConfig {
  childManifests?: string;
  /** Optional host RuntimeClass for the vcluster control plane and every pod it
   * syncs. The k8s driver refuses the claim when the class is absent. */
  runtimeClassName?: string;
  /**
   * Required with `childManifests`; refused without it — nothing would ever
   * create the named Deployment.
   *
   * A LIST gates on every Deployment it names, all of which must be Available
   * before the stamp is ready. That is not a convenience: it is how "the child
   * is up" stops being one workload's opinion. A whole-deployment stamp is
   * ready when its governance answers AND its gateway enforces AND its host
   * runs — and the gateway leg is the strong one, because a gateway's own
   * readinessProbe is `/v1/ready`, which answers 503 until it holds a policy
   * bundle it can decide against. With the list, that is what the warm gate
   * WAITS for rather than what an operator checks afterwards.
   */
  readiness?: StampReadiness | StampReadiness[];
  /**
   * Images this stamp's stream needs ALREADY IN THE NODE'S STORE, asserted
   * before the stamp is claimable (C15's node-local half).
   *
   * A `childManifests` stamp takes no registry origin (see
   * validateImageOrigin), so its images are operator-imported and nothing in
   * the platform has ever checked they arrived. A missing one is
   * `ImagePullBackOff`, which the stamp gate only ever sees as a Deployment
   * that never goes Available — so the claim polls out its whole boot budget
   * and dies as a generic timeout, with the real cause only in pod events.
   * That mute failure is already on the record for the missing `v06` dev
   * image. Declaring the set closes it: the registry's claim gate refuses BY
   * NAME in seconds, and the pool omits the stamp instead of burning a boot
   * budget per fill.
   *
   * Presence is by the name kubelet REPORTS (`node.status.images[].names`),
   * with `probeImage`'s honesty clamp inherited whole: kubelet caps that
   * report (`nodeStatusMaxImages`, default 50), so absence from a full report
   * proves nothing and answers "present". And a node-imported image has no
   * registry digest to report, so a tag here proves PRESENCE, never identity —
   * `docker save | ctr import` under an existing tag is invisible to this
   * check. Pin bits through the pull path's ledger, not through this list.
   */
  nodeImages?: string[];
  app?: AppStampSpec;
  /** The build origin — parsed and validated, refused at registration in v1 (see StampBuildSpec). */
  build?: StampBuildSpec;
  /**
   * The hot-loop opt-in (C16): how this stamp runs from a claimed working
   * tree instead of its baked artifact. Shape must match the stamp's —
   * `{mountPath, …}` for `app`, `{manifests, …}` for `childManifests` — and
   * every structural refusal it can earn lands at registration, in front of
   * the approver (see validateStampEntry). A stamp without it has no dev
   * flavor: `envs claim --dev` refuses at claim, naming the missing
   * declaration.
   */
  dev?: StampDevSpec;
}

/**
 * The one workload that consumes a dev claim's tree (one tree, one consumer):
 * the stampId-named Deployment for the app shape, and for childManifests the
 * gate the author DECLARED as `dev.consumer` — falling back to the single
 * declared gate when there is only one, because then there is nothing to
 * choose between.
 *
 * Never a guess in either arm: past one gate the declaration is required at
 * the write (validateStampDev), and a declaration that does not name a
 * declared gate is refused there too. This is the object the fidelity gate
 * reads its variant evidence off, so an inferred answer here would be a dev
 * claim reporting active over a Deployment that never mounted the tree.
 */
export function devConsumerGate(stampId: string, config: K8sStampConfig): StampReadiness {
  if (config.app) return { deployment: stampId, namespace: APP_STAMP_NAMESPACE };
  const gates = readinessGates(config);
  const declared = declaredDevConsumer(config);
  if (!declared) return gates[0]!;
  return gates.find((gate) => sameGate(gate, declared)) ?? gates[0]!;
}

/** The declared consumer, or null — only the childManifests dev shape carries one. */
function declaredDevConsumer(config: K8sStampConfig): StampDevConsumer | null {
  const dev = config.dev;
  if (!dev || !isDevManifests(dev)) return null;
  return dev.consumer ?? null;
}

function sameGate(a: { deployment: string; namespace: string }, b: { deployment: string; namespace: string }): boolean {
  return a.deployment === b.deployment && a.namespace === b.namespace;
}

/**
 * The declared readiness gates, normalized — the singular and list forms
 * reduce here and nowhere else, so validation, the driver's probe and the CLI
 * render can never disagree about how many gates a config declares.
 */
export function readinessGates(config: K8sStampConfig): StampReadiness[] {
  const declared = config.readiness;
  if (declared === undefined) return [];
  return Array.isArray(declared) ? declared : [declared];
}

/**
 * How one stamp's image reaches the node — the classification every C15
 * consumer branches on, derived in exactly one place so the registry's row
 * insertion, the claim gate, and the driver's render can never disagree about
 * what a config means.
 *
 * `none` = no app block (bare vcluster, childManifests): no image of ours to
 * place. `node-local` = the explicit opt-out. `pull` = the registry path —
 * rows, gate, placement.
 */
export type StampImageOrigin =
  | { kind: 'none' }
  | { kind: 'node-local' }
  | { kind: 'pull'; ref: string; credential?: string };

export function stampImageOrigin(config: K8sStampConfig): StampImageOrigin {
  if (!config.app) return { kind: 'none' };
  if (config.app.presence === 'node-local') return { kind: 'node-local' };
  return { kind: 'pull', ref: config.app.image, credential: config.app.imageCredential };
}

/**
 * The namespace a stamped app lands in inside its instance. The child cluster
 * IS the instance's world and teardown is the parent namespace going away, so
 * the app needs no scope of its own — `default` is where an agent will look.
 */
export const APP_STAMP_NAMESPACE = 'default';

const SAMPLE_APP_PORT = 8080;

/**
 * A persistent HTTP listener out of busybox's `nc`.
 *
 * Alpine's busybox has NO `httpd` applet — that lives in `busybox-extras`,
 * which the base image does not install (`busybox httpd` exits with "applet
 * not found", verified against the pinned image). `nc` IS in the applet list,
 * and `-lk -e` is busybox's documented persistent-server mode: the listener
 * survives every connection instead of exiting after the first, which is what
 * a readiness probe reconnecting every two seconds requires.
 *
 * The escapes are doubled on purpose: the container argument must contain
 * literal `\r\n` for busybox `printf` to turn into CRLF. Real control
 * characters in the argv would work by accident and break the moment anything
 * re-serializes them.
 */
function sampleAppCommand(port: number): string[] {
  const response =
    'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: 3\\r\\nConnection: close\\r\\n\\r\\nok\\n';
  // Read the request before answering it. `nc -e` closing a socket that still
  // holds unread bytes makes the kernel send RST instead of FIN, and RST
  // discards data the client has already received — the reply arrives
  // truncated at the status line (measured). Draining to the blank line that
  // ends the request headers makes the close orderly. A bare TCP probe that
  // sends nothing simply hits EOF and the responder exits.
  const serve = 'while read -r l; do [ ${#l} -le 1 ] && break; done; printf "' + response + '"';
  return ['/bin/busybox', 'nc', '-lk', '-p', String(port), '-e', '/bin/sh', '-c', serve];
}

/**
 * Stamps every deployment knows unless its configuration replaces them.
 *
 * `sample-app` is the v0 acceptance target, and its constraint is the node it
 * has to boot on: the POC node cannot pull from public registries, so the
 * image must be one the instance bundle already requires (VCLUSTER_IMAGES) and
 * is therefore guaranteed present. Everything it runs has to come out of that
 * image's own busybox. `k8s-driver.test.ts` pins the image to the bundle's
 * list, so a bundle re-render that moves the alpine ref fails there rather
 * than at claim time on the node.
 *
 * `nanoclaw` is the v0.5 target — the child becomes nanoclaw. Its image is
 * node-imported (source-carrying, never in any registry), so like every
 * childManifests stamp it declares the Deployment its readiness rides on.
 */
export const BUILTIN_STAMPS: Record<string, K8sStampConfig> = {
  'sample-app': {
    app: {
      image: 'mirror.gcr.io/library/alpine:3.20',
      // Explicit, not defaulted (C15): this image rides the pinned instance
      // bundle (VCLUSTER_IMAGES) and is guaranteed node-present — it must
      // never learn to pull, and a fully-qualified ref would otherwise read
      // as the registry origin.
      presence: 'node-local',
      port: SAMPLE_APP_PORT,
      command: sampleAppCommand(SAMPLE_APP_PORT),
    },
  },
  nanoclaw: {
    childManifests: NANOCLAW_CHILD_MANIFESTS,
    readiness: { deployment: NANOCLAW_HOST_DEPLOYMENT, namespace: NANOCLAW_NAMESPACE },
    // The hot loop, expressed through the generalized declaration (C16): the
    // proven dev render is the builtin's dev stream, tokens and all, so the
    // fidelity gate has exactly ONE implementation and the builtin proves it.
    dev: { manifests: NANOCLAW_DEV_CHILD_MANIFESTS, reload: { kind: 'rollout' } },
  },
};

/** Object names (Deployment, Service) must clear this; label values alone do not. */
const DNS_1123_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Stamp ids ride k8s labels (the driver's pool/adoption contract). */
const STAMP_LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

/**
 * Conservative image-ref grammar: `host/path[:tag][@sha256:hex]`. Registry
 * refs ride manifests AND placement argv, so anything outside this charset is
 * refused rather than escaped — the same posture every other operator string
 * in this file takes. Deliberately narrower than the OCI grammar (no uppercase
 * path segments, no `+` in tags): nothing a real registry serves needs them.
 */
const IMAGE_REF_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$/;

/**
 * The same grammar with the registry host OPTIONAL — a node-imported image is
 * exactly the case that has no registry host (`nanoclaw-child-host:v05`), and
 * a `nodeImages` entry never rides a manifest or a pull: it is compared, byte
 * for byte, against the names kubelet reports. So the squatter clamp that
 * governs `app.image` has nothing to protect here, while the charset refusal
 * still holds.
 */
const NODE_IMAGE_REF_RE =
  /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$/;

export const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Credential NAMES project into custody env keys (REGISTRY_<NAME>_…) — env-name grammar, nothing else. */
const IMAGE_CREDENTIAL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Build-arg keys ride argv wherever a driver invokes its builder. */
const BUILD_ARG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Fully qualified = an EXPLICIT registry host: the first path segment carries
 * a dot or a port, or is `localhost` — the same heuristic every CRI applies
 * before defaulting to docker.io. The refusal for anything else is the
 * squatter clamp (see AppStampSpec.image).
 */
export function fullyQualifiedImageRef(ref: string): boolean {
  const slash = ref.indexOf('/');
  if (slash <= 0) return false;
  const host = ref.slice(0, slash);
  return host.includes('.') || host.includes(':') || host === 'localhost';
}

/** The digest a pinned ref carries, or null for a tag-form ref. */
export function imageRefDigest(ref: string): string | null {
  const at = ref.lastIndexOf('@');
  if (at < 0) return null;
  const digest = ref.slice(at + 1);
  return IMAGE_DIGEST_RE.test(digest) ? digest : null;
}

export interface ValidateStampOptions {
  /**
   * True for the driver's static/env-configured tables. A code-provided stamp
   * has no registry row, so nothing can ever insert a placement record for it
   * — a registry-origin image there would be an unrealizable promise, refused
   * at construction in front of the operator who configured it.
   */
  codeProvided?: boolean;
  /**
   * True only on the CLI's pre-resolution check: a registry-origin ref is
   * digest-pinned by create-time resolution BEFORE it reaches the store, and
   * every stored row must carry the pin — an unpinned pull row is a signature
   * on bits nobody resolved (a tag is not a pin).
   */
  allowUnpinned?: boolean;
}

/**
 * Every structural refusal one stamp entry can earn, in one place — shared by
 * the driver's constructor (static/env-configured tables) and the stamps
 * registry's create/update path, so a registered manifest is refused AT
 * REGISTRATION, in front of the approving human, with the exact message a
 * misconfigured deployment would have gotten — never later as a claim that
 * fails to instantiate on the node or a boot that polls out its budget.
 */
export function validateStampEntry(stampId: string, config: K8sStampConfig, opts: ValidateStampOptions = {}): void {
  if (!STAMP_LABEL_RE.test(stampId)) throw new Error(`stamp id must be k8s-label-legal: ${stampId}`);
  if (config.runtimeClassName !== undefined && !DNS_1123_RE.test(config.runtimeClassName)) {
    throw new Error(`stamp runtimeClassName must be a legal RuntimeClass name: ${stampId}`);
  }
  validateImageOrigin(stampId, config, opts);
  // An app stamp's id NAMES objects in the child (Deployment, Service), and
  // the object grammar is stricter than the label grammar it already
  // passed. The alternative to refusing here is a stamp that claims
  // fine and then fails to instantiate, on the node, every time.
  if (config.app && !appStampNameLegal(stampId)) {
    throw new Error(`app stamp id must be a legal k8s object name (lowercase alphanumeric and '-'): ${stampId}`);
  }
  validateReadiness(stampId, config);
  validateNodeImages(stampId, config);
  // Platform authorship of the dev-tree claim is a create-time refusal (C16):
  // a stream — baked or dev — that declares the platform's own object or
  // names its reserved class collides at apply or bind time, as an
  // immutable-spec rejection or a claim that never binds. Refused here, in
  // front of the approver, on every stamp: a devless stamp naming the
  // reserved class would Pending forever too (no provisioner owns it).
  if (config.childManifests !== undefined) {
    refuseReservedDevObjects(stampId, config.childManifests, 'childManifests');
    refuseInheritedIdentity(stampId, config.childManifests, 'childManifests');
  }
  // The app shape's env is the same surface with a smaller mouth: one image,
  // one port, and a Record instead of a stream. The identity rule cannot
  // depend on which shape an author reached for.
  for (const [key, value] of Object.entries(config.app?.env ?? {})) {
    if (!isIdentityEnvKey(key)) continue;
    if (typeof value !== 'string' || !value.includes(INSTANCE_TOKEN)) {
      throw new Error(
        `app.env sets ${key} to a literal — installation identity must be minted per instance; derive it from ` +
          `"${INSTANCE_TOKEN}" (e.g. "org-${INSTANCE_TOKEN}"): ${stampId}`,
      );
    }
  }
  if (config.dev) validateStampDev(stampId, config);
}

/**
 * The readiness declaration's refusals, singular and plural in one place.
 *
 * The plural form earns two of its own. An EMPTY list is the silent-warm
 * shape wearing a declaration: `readiness: []` reads as "gated" to a human and
 * as "bare vcluster" to `readinessGates`, and a slot would go warm on a
 * vcluster nobody stamped. DUPLICATE pairs are a probe budget spent twice on
 * one Deployment and — worse — a list an author believes covers three
 * components while it covers two.
 */
function validateReadiness(stampId: string, config: K8sStampConfig): void {
  const declared = config.readiness;
  if (Array.isArray(declared) && declared.length === 0) {
    throw new Error(
      `stamp readiness is an empty list — that declares no gate at all, and the slot would go warm on a bare ` +
        `vcluster; name every Deployment that must be Available: ${stampId}`,
    );
  }
  const gates = readinessGates(config);
  // A childManifests stamp carries names the driver does not interpret, so
  // the readiness declaration is the only definition of "up" it has.
  // Without this refusal the warm gate quietly measures only the bare
  // vcluster — a slot goes warm, a claim hands it out, and nobody ever
  // waited for the thing the stamp exists to run.
  if (config.childManifests !== undefined && gates.length === 0) {
    throw new Error(
      `childManifests stamp must declare readiness ({deployment, namespace}, or a list of them): ${stampId}`,
    );
  }
  // The mirror-image config lie: a readiness gate on a Deployment nothing
  // in this stamp ever creates would wait out the boot budget, every time.
  if (gates.length > 0 && config.childManifests === undefined) {
    throw new Error(`stamp readiness without childManifests can never be met: ${stampId}`);
  }
  const seen = new Set<string>();
  for (const entry of gates as unknown[]) {
    // The declared names ride kubectl argv on every probe; refuse anything
    // that is not a legal name for its field before it gets there — the
    // Deployment name is subdomain-grammar (dots legal), the namespace the
    // stricter label grammar. Shape first: config arrives as parsed JSON, so
    // a non-object entry must earn a refusal rather than a TypeError.
    const gate = entry as Partial<StampReadiness> | null;
    if (
      typeof gate !== 'object' ||
      gate === null ||
      typeof gate.deployment !== 'string' ||
      typeof gate.namespace !== 'string' ||
      !(deploymentNameLegal(gate.deployment) && appStampNameLegal(gate.namespace))
    ) {
      throw new Error(`stamp readiness names must be legal k8s object names ({deployment, namespace}): ${stampId}`);
    }
    const key = `${gate.namespace}/${gate.deployment}`;
    if (seen.has(key)) {
      throw new Error(`stamp readiness names '${key}' twice — a duplicate gate measures one Deployment: ${stampId}`);
    }
    seen.add(key);
  }
}

/** How many node images one stamp may assert — each costs a node read at the claim gate. */
const NODE_IMAGES_MAX = 32;

function validateNodeImages(stampId: string, config: K8sStampConfig): void {
  const declared = config.nodeImages;
  if (declared === undefined) return;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      `nodeImages must be a non-empty list of image refs the node must already hold — omit the field entirely ` +
        `to assert nothing: ${stampId}`,
    );
  }
  if (declared.length > NODE_IMAGES_MAX) {
    throw new Error(`nodeImages declares ${declared.length} images; the limit is ${NODE_IMAGES_MAX}: ${stampId}`);
  }
  const seen = new Set<string>();
  for (const ref of declared) {
    if (typeof ref !== 'string' || !NODE_IMAGE_REF_RE.test(ref)) {
      throw new Error(
        `nodeImages entry does not parse as an image ref ([host/]path[:tag][@sha256:…]) — it is compared against ` +
          `the names kubelet reports, so it must be written exactly as the node holds it: ${stampId}`,
      );
    }
    if (seen.has(ref)) throw new Error(`nodeImages names '${ref}' twice: ${stampId}`);
    seen.add(ref);
  }
}

/**
 * The dev block's structural refusals (C16), all at the write: shape match,
 * the mount-point grammar, the reload vocabulary, and — for author-supplied
 * dev streams — the tree-owner identity CLAMP. The clamp is the one rule
 * that must never be approver vigilance: PSA baseline permits root, so an
 * image-default-root consumer would write node-root-owned files into the
 * claimant's session workspace — a tree later mounted into sandboxes — and a
 * declared fsGroup would recursively chgrp it at mount.
 */
function validateStampDev(stampId: string, config: K8sStampConfig): void {
  const dev = config.dev!;
  if (!config.app && config.childManifests === undefined) {
    throw new Error(`dev block on a bare-vcluster stamp — no consumer exists to mount a tree into: ${stampId}`);
  }
  if (config.app && config.childManifests !== undefined) {
    throw new Error(
      `dev block on a stamp with both app and childManifests — one tree has one consumer, and this stamp names two; drop one shape: ${stampId}`,
    );
  }
  validateDevReload(stampId, dev.reload);
  if (config.app) {
    if (isDevManifests(dev)) {
      throw new Error(
        `an app stamp's dev block declares {mountPath, …} — the driver renders the dev variant; dev.manifests belongs to childManifests stamps: ${stampId}`,
      );
    }
    if (typeof dev.mountPath !== 'string' || !dev.mountPath.startsWith('/')) {
      throw new Error(`dev.mountPath must be an absolute path inside the consuming container: ${stampId}`);
    }
    return;
  }
  if (!isDevManifests(dev) || typeof dev.manifests !== 'string' || !dev.manifests.trim()) {
    throw new Error(
      `a childManifests stamp's dev block declares {manifests, …} — the author supplies the dev variant stream: ${stampId}`,
    );
  }
  // One tree, one consumer — and with a multi-gate stamp the platform cannot
  // say WHICH gate consumes it. The fidelity gate reads its variant evidence
  // off the consuming Deployment (devConsumerGate), so a GUESS here would be a
  // dev claim reporting active over a gate that never mounted the tree: the
  // exact silent-bake shape #209 exists to kill.
  //
  // The answer is a declaration, not a refusal: a whole-deployment stamp must
  // be able to gate on `[governance, gateway, host]` AND run its host from a
  // working tree, and those two are only in tension while the consumer is
  // implicit. `dev.consumer` makes it explicit. Everything below is what keeps
  // the declaration from becoming a second way to lie — it must name a gate
  // the stamp actually declares, and past one gate it is not optional.
  const gates = readinessGates(config);
  validateDevConsumer(stampId, gates, dev.consumer);
  refuseReservedDevObjects(stampId, dev.manifests, 'dev.manifests');
  refuseInheritedIdentity(stampId, dev.manifests, 'dev.manifests');
  validateDevManifestsClamp(stampId, dev.manifests);
  refuseUngatedDevStream(stampId, gates, dev.manifests);
}

/**
 * A dev variant realizes the SAME deployment, so it must still create every
 * Deployment the stamp gates on.
 *
 * The driver applies the dev stream INSTEAD OF `childManifests`, and a dev
 * claim waits on every declared gate — so a dev stream that drops a leg is a
 * claim that polls out its whole boot budget and dies as a generic timeout,
 * with the real cause ("nothing ever created this Deployment") visible only to
 * someone who diffs two manifest streams by hand.
 *
 * The alternative — gating a dev claim on its consumer alone — is worse and is
 * the reason this check exists at all: it would let a whole-deployment stamp go
 * READY in its dev flavor with its governance and its gateway down, which is
 * precisely the silent under-gating a readiness LIST exists to kill.
 *
 * Free to check: `validateDevManifestsClamp` has already refused any dev stream
 * that is not JSON documents, so the parse here cannot fail on a legal stamp.
 */
function refuseUngatedDevStream(stampId: string, gates: StampReadiness[], manifests: string): void {
  const docs = parseJsonDocs(manifests);
  if (!docs) return; // unreachable: the clamp above refuses a non-JSON dev stream first
  const declared = new Set<string>();
  for (const doc of docs) {
    const obj = doc as { kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } };
    if (obj?.kind !== 'Deployment') continue;
    declared.add(`${String(obj.metadata?.namespace)}/${String(obj.metadata?.name)}`);
  }
  const missing = gates
    .map((gate) => `${gate.namespace}/${gate.deployment}`)
    .filter((gate) => !declared.has(gate));
  if (missing.length === 0) return;
  throw new Error(
    `dev.manifests never creates ${missing.join(', ')}, which this stamp's readiness gates on — the dev stream ` +
      `REPLACES childManifests, so a dev claim would wait out its whole boot budget on a Deployment nothing in ` +
      `the dev flavor declares: ${stampId}`,
  );
}

/**
 * The declared consumer's refusals. Three, and each closes a way the
 * declaration could be worse than the guess it replaces:
 *
 * - PAST ONE GATE IT IS REQUIRED. Absent, `devConsumerGate` would fall back to
 *   the first declared gate — which is an ORDER-DEPENDENT guess, the worst
 *   kind, because reordering a readiness list would silently move the hot
 *   loop's consumer.
 * - IT MUST NAME A DECLARED GATE. A consumer nothing gates on has no Available
 *   condition the fidelity gate can read its variant evidence off, so the dev
 *   claim would go ready on a Deployment nobody waited for.
 * - SHAPE FIRST. Config arrives as parsed JSON, so a non-object must earn a
 *   refusal rather than a TypeError.
 */
function validateDevConsumer(stampId: string, gates: StampReadiness[], declared: unknown): void {
  if (declared === undefined) {
    if (gates.length > 1) {
      throw new Error(
        `dev block on a stamp with ${gates.length} readiness gates declares no dev.consumer — one tree has one ` +
          `consumer, and the platform must not guess which gate mounts it; name it ` +
          `({deployment, namespace}, one of the declared readiness gates): ${stampId}`,
      );
    }
    return;
  }
  const consumer = declared as Partial<StampDevConsumer> | null;
  if (
    typeof consumer !== 'object' ||
    consumer === null ||
    typeof consumer.deployment !== 'string' ||
    typeof consumer.namespace !== 'string'
  ) {
    throw new Error(`dev.consumer must be {deployment, namespace}: ${stampId}`);
  }
  if (!gates.some((gate) => sameGate(gate, consumer as StampDevConsumer))) {
    throw new Error(
      `dev.consumer names '${consumer.namespace}/${consumer.deployment}', which this stamp's readiness does not ` +
        `gate on (${gates.map((gate) => `${gate.namespace}/${gate.deployment}`).join(', ') || 'no gates'}) — the ` +
        `fidelity gate reads the dev variant off the CONSUMING Deployment's Available condition, so a consumer ` +
        `nothing waits for would report a dev claim ready over a tree nothing mounted: ${stampId}`,
    );
  }
}

function validateDevReload(stampId: string, reload: StampDevSpec['reload']): void {
  if (reload === undefined) return; // absent = rollout, the default
  if (reload.kind === 'rollout' || reload.kind === 'none') return;
  if (reload.kind === 'exec') {
    if (!Array.isArray(reload.command) || reload.command.length === 0 || reload.command.some((c) => typeof c !== 'string')) {
      throw new Error(`dev.reload exec needs a non-empty command array (exec'd in the consuming pod): ${stampId}`);
    }
    return;
  }
  throw new Error(
    `unknown dev.reload kind '${String((reload as { kind?: unknown }).kind)}' — the vocabulary is rollout | exec | none: ${stampId}`,
  );
}

/**
 * The identity clamp on author-supplied dev streams: every pod template that
 * mounts `dev-tree` must run as the stat'd tree owner — the tokens verbatim,
 * no fsGroup, no container-level identity override that would out-vote the
 * pod's. Mechanically checkable is part of the contract, which is why the
 * stream must parse as JSON documents (JSON is YAML — both in-tree renders
 * already emit it) — a stream the clamp cannot read is refused, never waved
 * through. A dev stream whose templates never mount the tree is refused too:
 * that is a tree that could never be live, and the fidelity gate at boot is
 * the runtime backstop for the same mistake, not the first report of it.
 */
function validateDevManifestsClamp(stampId: string, manifests: string): void {
  const docs = parseJsonDocs(manifests);
  if (!docs) {
    throw new Error(
      `dev.manifests must be a stream of JSON documents (JSON is YAML) — the tree-owner identity clamp must be ` +
        `mechanically checkable at registration: ${stampId}`,
    );
  }
  const mounting = docs.flatMap(podSpecsOf).filter(mountsDevTree);
  if (mounting.length === 0) {
    throw new Error(
      `dev.manifests has no pod template mounting the '${DEV_TREE_PVC}' claim — the claimed tree could never be live: ${stampId}`,
    );
  }
  for (const podSpec of mounting) {
    const identity = (podSpec.securityContext ?? {}) as Record<string, unknown>;
    if (identity.runAsUser !== DEV_TREE_UID_TOKEN || identity.runAsGroup !== DEV_TREE_GID_TOKEN) {
      throw new Error(
        `a dev.manifests pod template mounts '${DEV_TREE_PVC}' without the identity tokens — its securityContext ` +
          `must carry runAsUser: "${DEV_TREE_UID_TOKEN}" / runAsGroup: "${DEV_TREE_GID_TOKEN}" verbatim ` +
          `(the platform substitutes the stat'd tree owner): ${stampId}`,
      );
    }
    if (identity.fsGroup !== undefined) {
      throw new Error(
        `a dev.manifests pod template mounting '${DEV_TREE_PVC}' declares fsGroup — the kubelet would recursively ` +
          `chgrp the developer's working tree at mount; drop it: ${stampId}`,
      );
    }
    for (const container of containersOf(podSpec)) {
      const override = (container.securityContext ?? {}) as Record<string, unknown>;
      if (override.runAsUser !== undefined || override.runAsGroup !== undefined) {
        throw new Error(
          `a container in a '${DEV_TREE_PVC}'-mounting pod template overrides runAsUser/runAsGroup — the ` +
            `tree-owner identity is a clamp and a container-level value out-votes the pod's tokens: ${stampId}`,
        );
      }
    }
  }
}

/**
 * The platform-collision refusals: no stream may declare a PVC named
 * `dev-tree` (the platform authors that claim) or name the reserved static
 * class (no provisioner answers it — a claim that never binds). Precise for
 * JSON streams; a YAML stream gets a conservative textual scan — over-refusal
 * at create with the reason named beats an immutable-spec apply rejection
 * after a claim.
 */
function refuseReservedDevObjects(stampId: string, stream: string, field: string): void {
  const classRefusal = () =>
    new Error(
      `${field} names the reserved storage class '${DEV_TREE_STORAGE_CLASS}' — it belongs to the platform's ` +
        `pre-bound dev-tree claims and no provisioner answers it: ${stampId}`,
    );
  const pvcRefusal = () =>
    new Error(
      `${field} declares a PersistentVolumeClaim named '${DEV_TREE_PVC}' — the platform authors that claim for ` +
        `dev-flavor instances; the stream may only MOUNT it: ${stampId}`,
    );
  const docs = parseJsonDocs(stream);
  if (docs) {
    for (const doc of docs) {
      const obj = doc as { kind?: unknown; metadata?: { name?: unknown } };
      if (obj?.kind === 'PersistentVolumeClaim' && obj.metadata?.name === DEV_TREE_PVC) throw pvcRefusal();
      if (JSON.stringify(doc).includes(DEV_TREE_STORAGE_CLASS)) throw classRefusal();
    }
    return;
  }
  if (stream.includes(DEV_TREE_STORAGE_CLASS)) throw classRefusal();
  if (
    stream.includes('PersistentVolumeClaim') &&
    new RegExp(`name:\\s*["']?${DEV_TREE_PVC}["']?\\s*$`, 'm').test(stream)
  ) {
    throw pvcRefusal();
  }
}

/**
 * The THEATRE refusal (C3): a stream that hard-codes installation identity is
 * not a governed deployment of its own — it is a second front door onto the
 * one that already exists.
 *
 * `mint-env-pki.sh` and `spike-pki.sh` establish the rule this enforces: two
 * things sharing `ORG_ID`/`INSTALL_ID` ARE the same installation to governance
 * and the gateway. A child that inherits them has a gateway that accepts the
 * parent's deployment certificate and `governance.agents` rows scoped to an
 * org that already exists — it WORKS, wrongly, which is the failure mode that
 * matters. So the identity values must be DERIVED from `${INSTANCE}`, and this
 * is the one place where "governed" is mechanical instead of a review
 * convention.
 *
 * Three refusals, in the order an author meets them:
 *
 * - a YAML stream that names an identity key at all — the check must be
 *   mechanical, and the same precedent already governs `dev.manifests`;
 * - a `valueFrom` (or a base64 Secret `data` entry) on an identity key — the
 *   approver signs what they can read, and an indirection is exactly where an
 *   inherited value hides;
 * - a literal that does not carry the token.
 *
 * WHAT THIS REFUSAL IS ABOUT, PRECISELY: identity NAMES, not identity
 * MATERIAL. It reads a stream for identity-shaped ENV KEYS and ConfigMap/Secret
 * payload keys and nothing else. Nothing here — and nothing anywhere else in
 * this module — mints or checks a child's CA bundle, its `master.key`, or its
 * service-account signing key: those arrive however the stream's own author
 * arranged, and a stream that mounts the PARENT's material while deriving its
 * names from `${INSTANCE}` passes this check. So the guarantee is "the child
 * cannot CLAIM to be the parent", not "the child cannot BE the parent" — the
 * second needs per-instance material, which is a later increment.
 *
 * What it also does not cover, deliberately: identity passed as a command
 * ARGUMENT, or under a key that is not identity-SHAPED (see
 * IDENTITY_ENV_KEY_RE). All of it declared in SKILL.md — this is a floor under
 * the review, not a substitute for it.
 */
function refuseInheritedIdentity(stampId: string, stream: string, field: string): void {
  // The cheap pre-check, so a stream that mentions no identity at all pays
  // nothing and cannot be refused for its serialization.
  if (!IDENTITY_MENTION_RE.test(stream)) return;
  const docs = parseJsonDocs(stream);
  if (!docs) {
    throw new Error(
      `${field} names an installation identity (a *ORG_ID / *INSTALL_ID key) but is not a stream of JSON ` +
        `documents (JSON is YAML) — the per-instance identity refusal must be mechanically checkable at ` +
        `registration: ${stampId}`,
    );
  }
  for (const doc of docs) {
    for (const found of identityAssignments(doc)) {
      if (found.value === null) {
        throw new Error(
          `${field} sets ${found.key} from ${found.source} — installation identity must be readable in the stream ` +
            `the approver signs and minted per instance; write the value inline, derived from ` +
            `"${INSTANCE_TOKEN}": ${stampId}`,
        );
      }
      if (!found.value.includes(INSTANCE_TOKEN)) {
        throw new Error(
          `${field} sets ${found.key} to the literal '${found.value}' — two installations sharing it ARE one ` +
            `installation to governance and the gateway, so a claim of this stamp would be a second front door onto ` +
            `an existing org, not a governed deployment of its own; derive it from "${INSTANCE_TOKEN}" ` +
            `(e.g. "org-${INSTANCE_TOKEN}"): ${stampId}`,
        );
      }
    }
  }
}

interface IdentityAssignment {
  key: string;
  /** The literal, or null when the stream hides it behind an indirection. */
  value: string | null;
  /** What the indirection was, for the refusal's message. */
  source: string;
}

/**
 * Every place one document assigns an identity key, found structurally rather
 * than by enumerating kinds: an env entry anywhere (containers, initContainers,
 * a sidecar, a Job template, a kind this walk has never heard of) plus
 * ConfigMap/Secret data. Same posture as `podSpecsOf` — a shape the walk does
 * not recognize must not be able to smuggle an identity past it.
 */
function identityAssignments(doc: unknown): IdentityAssignment[] {
  const found: IdentityAssignment[] = [];
  const identityKey = (name: unknown): name is string => typeof name === 'string' && isIdentityEnvKey(name);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    // An env entry: `{name, value}` or `{name, valueFrom}`.
    if (identityKey(record.name) && ('value' in record || 'valueFrom' in record)) {
      found.push(
        typeof record.value === 'string'
          ? { key: record.name, value: record.value, source: 'value' }
          : { key: record.name, value: null, source: 'valueFrom' in record ? 'valueFrom' : 'a non-string value' },
      );
    }
    // ConfigMap/Secret payloads: readable keys carry their literal; a base64
    // `data` entry is an indirection the approver cannot read.
    if (record.kind === 'ConfigMap' || record.kind === 'Secret') {
      for (const [key, value] of Object.entries((record.stringData ?? {}) as Record<string, unknown>)) {
        if (identityKey(key)) found.push({ key, value: typeof value === 'string' ? value : null, source: 'stringData' });
      }
      for (const key of Object.keys((record.data ?? {}) as Record<string, unknown>)) {
        if (!identityKey(key)) continue;
        found.push(
          record.kind === 'Secret'
            ? { key, value: null, source: 'a base64 Secret data entry' }
            : {
                key,
                value: typeof (record.data as Record<string, unknown>)[key] === 'string'
                  ? ((record.data as Record<string, string>)[key] as string)
                  : null,
                source: 'data',
              },
        );
      }
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(doc);
  return found;
}

/** A document stream as parsed JSON docs, or null when any document is not JSON (a YAML stream). */
function parseJsonDocs(stream: string): unknown[] | null {
  const docs: unknown[] = [];
  for (const raw of stream.split(/^---$/m)) {
    if (!raw.trim()) continue;
    try {
      docs.push(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return docs;
}

interface PodSpecish {
  securityContext?: unknown;
  containers?: unknown;
  initContainers?: unknown;
  volumes?: unknown;
}

/**
 * Every pod spec a workload document carries, found structurally (an object
 * with a `containers` array) rather than by enumerating kinds — Deployments,
 * StatefulSets, Jobs, CronJobs and bare Pods all reduce to it, and a kind
 * this walk has never heard of still cannot smuggle a template past the
 * clamp.
 */
function podSpecsOf(doc: unknown): PodSpecish[] {
  const found: PodSpecish[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.containers)) found.push(record as PodSpecish);
    for (const value of Object.values(record)) walk(value);
  };
  walk(doc);
  return found;
}

function containersOf(podSpec: PodSpecish): Array<{ securityContext?: unknown }> {
  const lists = [podSpec.containers, podSpec.initContainers];
  return lists.flatMap((list) => (Array.isArray(list) ? (list as Array<{ securityContext?: unknown }>) : []));
}

function mountsDevTree(podSpec: PodSpecish): boolean {
  if (!Array.isArray(podSpec.volumes)) return false;
  return (podSpec.volumes as Array<{ persistentVolumeClaim?: { claimName?: unknown } }>).some(
    (volume) => volume?.persistentVolumeClaim?.claimName === DEV_TREE_PVC,
  );
}

/**
 * The C15 image-origin refusals: mutually exclusive shapes, the squatter
 * clamp on unqualified refs, the digest pin, and the honest not-yet-realized
 * refusal for the build origin — all at the write, in front of whoever is
 * about to sign the thing.
 */
function validateImageOrigin(stampId: string, config: K8sStampConfig, opts: ValidateStampOptions): void {
  if (config.build) {
    // Grammar first — an author whose build block is malformed should hear
    // that, not only that builds are unrealized.
    validateBuildSpec(stampId, config.build);
    // The two origins are mutually exclusive, checked before the capability
    // refusal so the both-and case names its own fault (the check outlives
    // the day a driver learns to build).
    if (config.app && stampImageOrigin(config).kind === 'pull') {
      throw new Error(
        `stamp declares both a registry image (app.image) and a build block — the two origins are mutually exclusive; keep exactly one: ${stampId}`,
      );
    }
    // Honest capability gate, static in v1: no installed driver declares
    // imageBuild (the pod session driver's own contract already says why —
    // PSA baseline forbids what a nested builder needs). Refused at create,
    // in front of the author, never discovered as a boot timeout.
    throw new Error(
      `the build origin is not yet realized on this deployment (no driver declares imageBuild) — publish the image ` +
        `to a registry and name it in app.image, or declare presence: 'node-local' for a node-imported one: ${stampId}`,
    );
  }
  if (!config.app) return;
  const { image, presence, imageCredential } = config.app;
  if (presence !== undefined && presence !== 'registry' && presence !== 'node-local') {
    throw new Error(`app.presence must be 'registry' or 'node-local', got '${String(presence)}': ${stampId}`);
  }
  if (imageCredential !== undefined && !IMAGE_CREDENTIAL_RE.test(imageCredential)) {
    throw new Error(`app.imageCredential must be a credential NAME (letters, digits, _ or -): ${stampId}`);
  }
  if (presence === 'node-local') {
    // A named pull credential on a stamp that never pulls is a config lie —
    // one of the two fields is not saying what its author thinks it says.
    if (imageCredential !== undefined) {
      throw new Error(
        `app.imageCredential names a pull credential, but presence 'node-local' never pulls — drop one: ${stampId}`,
      );
    }
    return;
  }
  // The pull origin (the default — node-local is the explicit opt-out).
  if (opts.codeProvided) {
    throw new Error(
      `a code-provided stamp table cannot carry a registry-origin image — nothing ever places for it; ` +
        `declare presence: 'node-local' (the image must already be on the node): ${stampId}`,
    );
  }
  if (config.childManifests !== undefined) {
    throw new Error(
      `childManifests stamps take no registry-origin image in v1 — declare presence: 'node-local': ${stampId}`,
    );
  }
  if (!fullyQualifiedImageRef(image)) {
    throw new Error(
      `registry image refs must be fully qualified (an explicit registry host — '${image}' would normalize to ` +
        `docker.io, a registerable name); for a node-imported image declare presence: 'node-local': ${stampId}`,
    );
  }
  if (!IMAGE_REF_RE.test(image)) {
    throw new Error(`registry image ref does not parse as host/path[:tag][@sha256:…]: ${stampId}`);
  }
  if (!opts.allowUnpinned && imageRefDigest(image) === null) {
    throw new Error(
      `registry image must be digest-pinned (ref@sha256:…) — create-time resolution pins it; a stored tag is a ` +
        `signature on bits nobody resolved: ${stampId}`,
    );
  }
}

function validateBuildSpec(stampId: string, build: StampBuildSpec): void {
  const { dockerfile, args } = build;
  if (dockerfile !== undefined) {
    // Repo-relative only: an absolute path or a `..` segment reaches outside
    // the clone wherever a builder eventually runs it.
    if (dockerfile.startsWith('/') || dockerfile.split('/').includes('..')) {
      throw new Error(`build.dockerfile must be repo-relative with no '..' segments: ${stampId}`);
    }
  }
  for (const key of Object.keys(args ?? {})) {
    if (!BUILD_ARG_KEY_RE.test(key)) {
      throw new Error(`build.args key not argv-safe: '${key}': ${stampId}`);
    }
  }
}

export function appStampNameLegal(stampId: string): boolean {
  return DNS_1123_RE.test(stampId);
}

/**
 * Deployment names are RFC-1123 SUBDOMAINS — dot-joined labels, 253 chars —
 * looser than the label grammar above (which Namespaces DO answer to). A
 * readiness declaration must not be stricter than the apiserver: a
 * third-party childManifests bundle may legally name its gate Deployment
 * `ingress.controller`, and both grammars are equally safe on kubectl argv.
 */
const DNS_1123_SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function deploymentNameLegal(name: string): boolean {
  return name.length <= 253 && DNS_1123_SUBDOMAIN_RE.test(name);
}

/**
 * Deployment + Service for one app stamp, as a YAML document stream.
 *
 * Emitted as JSON documents (JSON is YAML): an image ref, an env value or a
 * command argument is arbitrary operator-supplied text, and hand-rolled YAML
 * quoting is where that becomes an injection into the manifest. The stream
 * shape is what `Kube.apply` already takes.
 *
 * Idempotent by construction — every name is derived from the stamp id, so
 * re-applying converges instead of accumulating.
 */
export function renderAppManifests(stampId: string, spec: AppStampSpec): string {
  return renderApp(stampId, spec, null);
}

/**
 * The app stamp's DEV VARIANT (C16): the same Deployment/Service, plus the
 * platform's `dev-tree` claim mounted at the declared path, with
 * command/image/env overridden where the dev block says so — run from the
 * tree instead of the baked artifact. The tree-owner identity is
 * DRIVER-RENDERED here (the clamp column's app-shape half): pod
 * securityContext = the stat'd owner, fsGroup deliberately absent — the
 * kubelet must never chgrp a developer's working tree at mount. Readiness
 * stays the port probe on the same Deployment; the fidelity gate exists
 * because both flavors gate on it.
 */
export function renderDevAppManifests(
  stampId: string,
  spec: AppStampSpec,
  dev: StampDevApp,
  identity: DevTreeIdentity,
): string {
  return renderApp(stampId, spec, { dev, identity });
}

function renderApp(stampId: string, spec: AppStampSpec, variant: { dev: StampDevApp; identity: DevTreeIdentity } | null): string {
  const labels = { app: stampId };
  const command = variant?.dev.command ?? spec.command;
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: stampId, namespace: APP_STAMP_NAMESPACE, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          ...(variant
            ? {
                securityContext: {
                  runAsUser: variant.identity.runAsUser,
                  runAsGroup: variant.identity.runAsGroup,
                },
              }
            : {}),
          containers: [
            {
              name: 'app',
              image: variant?.dev.image ?? spec.image,
              // The node has the image or the stamp does not boot; never reach
              // for a registry the deployment may not be able to see. Dev
              // images obey the same clamp — node-local, never a pull at claim.
              imagePullPolicy: 'IfNotPresent',
              ...(command ? { command } : {}),
              ports: [{ containerPort: spec.port }],
              env: Object.entries({ ...spec.env, ...variant?.dev.env }).map(([name, value]) => ({ name, value })),
              // Serving the port IS readiness for a generic app: it is the only
              // health signal a stamp this generic can honestly claim, and it
              // is what the driver's readiness (and the pool's warm gate) waits
              // on — an app stamp is not ready until something is listening.
              readinessProbe: { tcpSocket: { port: spec.port }, periodSeconds: 2, failureThreshold: 60 },
              ...(variant ? { volumeMounts: [{ name: DEV_TREE_PVC, mountPath: variant.dev.mountPath }] } : {}),
            },
          ],
          ...(variant
            ? { volumes: [{ name: DEV_TREE_PVC, persistentVolumeClaim: { claimName: DEV_TREE_PVC } }] }
            : {}),
        },
      },
    },
  };
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: stampId, namespace: APP_STAMP_NAMESPACE, labels },
    spec: {
      selector: labels,
      ports: [{ name: 'app', port: spec.port, targetPort: spec.port, protocol: 'TCP' }],
    },
  };
  return [deployment, service].map((doc) => JSON.stringify(doc, null, 2)).join('\n---\n');
}
