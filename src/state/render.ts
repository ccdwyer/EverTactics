/**
 * EverTactics — render-layer glue.
 *
 * Two subsystems were written to different contracts and meet here:
 *
 *  - `render/stage.ts` composes the scene into a linear-HDR target and hands a
 *    `PostPipeline` that target plus its depth buffer.
 *  - `render/post.ts`'s `PostStack` renders the scene *itself*, because it needs
 *    its own colour target plus a second, sprite-only pass for the AA/AO mask —
 *    neither of which can be reconstructed from a flattened buffer.
 *
 * `PostStackPipeline` adapts one to the other. Stage grew a `rendersScene` flag
 * so it skips its own scene render when the pipeline says it owns it; without
 * that the scene would be drawn twice per frame.
 *
 * The other thing this file owns is the sprite `Layers` channel. `PostStack`
 * wants a channel number so it can isolate unit billboards from FXAA (running
 * FXAA over pixel art destroys it) — nobody picked one, so it is defined here
 * and applied to every sprite as it is created.
 */

import { NoToneMapping, type Object3D, type WebGLRenderer } from 'three';

import type { PostPipeline, PostRenderContext, Stage } from '@render/stage';
import { PostStack, type PostQuality } from '@render/post';

/**
 * three `Layers` channel for unit billboards.
 *
 * Sprites sit on channel 0 **and** this one: channel 0 keeps them in the main
 * render and, crucially, in the directional light's shadow pass (three tests
 * `object.layers` against the shadow camera, which only sees channel 0), while
 * this channel lets `PostStack` re-render them alone into the sprite mask.
 */
export const SPRITE_LAYER = 3;

/** Put an object and its whole subtree on the sprite channel, keeping channel 0. */
export function markAsSprite(object: Object3D): void {
  object.traverse((child) => child.layers.enable(SPRITE_LAYER));
}

export interface PostPipelineOptions {
  quality?: PostQuality;
  grade?: string;
  tileSize?: number;
}

export class PostStackPipeline implements PostPipeline {
  readonly stack: PostStack;
  /** Tells Stage not to render the scene — this pipeline does it. */
  readonly rendersScene = true;

  constructor(renderer: WebGLRenderer, opts: PostPipelineOptions = {}) {
    this.stack = new PostStack(renderer, {
      spriteLayer: SPRITE_LAYER,
      tileSize: opts.tileSize ?? 1,
      quality: opts.quality ?? 'high',
      ...(opts.grade !== undefined ? { grade: opts.grade } : {}),
    });
    // Deterministic screenshots: animated grain would differ frame to frame.
    this.stack.settings.grain.animate = false;
  }

  setSize(widthPx: number, heightPx: number, pixelRatio: number): void {
    // Stage speaks device pixels; PostStack takes CSS pixels plus a ratio.
    this.stack.setSize(widthPx / pixelRatio, heightPx / pixelRatio, pixelRatio);
  }

  render(ctx: PostRenderContext): void {
    this.stack.render(ctx.scene, ctx.camera, ctx.deltaSeconds);
  }

  /**
   * The stack is FXAA-based with no temporal accumulation, so a frame is final
   * as soon as it is drawn. If a TAA pass is ever added this must start
   * reporting the accumulation state or `__EVERTACTICS_READY__` will fire early.
   */
  get converged(): boolean {
    return true;
  }

  dispose(): void {
    this.stack.dispose();
  }
}

/**
 * Install the post stack on a stage.
 *
 * `PostStack` tone maps and sRGB-encodes in its own final pass and writes
 * straight to the default framebuffer, so three must not do it a second time on
 * the way out.
 */
export function installPostStack(stage: Stage, opts: PostPipelineOptions = {}): PostStackPipeline {
  const pipeline = new PostStackPipeline(stage.renderer, opts);
  stage.renderer.toneMapping = NoToneMapping;
  stage.setPostPipeline(pipeline);
  return pipeline;
}
