// @flow

import TinySDF from "@mapbox/tiny-sdf";
import isEqual from "lodash/isEqual";
import memoizeOne from "memoize-one";
import React, { useState } from "react";

import { withPose, toRGBA, defaultBlend, defaultDepth, shouldConvert, pointToVec3 } from "../utils/commandUtils";
import Command, { type CommonCommandProps } from "./Command";
import { isColorDark, type TextMarker } from "./Text";

// The GLText command renders text from a Signed Distance Field texture.
// There are many external resources about SDFs and text rendering in WebGL, including:
// https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf
// https://blog.mapbox.com/drawing-text-with-signed-distance-fields-in-mapbox-gl-b0933af6f817
// http://hack.chrons.me/opengl-text-rendering/
// https://stackoverflow.com/questions/25956272/better-quality-text-in-webgl
//
// Approach
// ========
// Characters from the font are measured using a <canvas> and the SDFs are drawn into a texture up front
// (and whenever new characters are being rendered). Then one instanced draw call is made with an instance
// per character which reads from the corresponding place in the texture atlas.
//
// Possible future improvements
// ============================
// - Allow customization of font style, maybe highlight ranges.
// - Add a scaleInvariant option.
// - Consider a solid rectangular background instead of an outline. This is challenging because the
//   instances currently overlap, so there will be z-fighting, but might be possible using the stencil buffer and multiple draw calls.
// - Somehow support kerning and more advanced font metrics. However, the web font APIs may not
//   provide support for this. Some font info could be generated/stored offline, possibly including the atlas.

type Props = {
  ...CommonCommandProps,
  children: $ReadOnlyArray<TextMarker & { billboard?: boolean }>,
  autoBackgroundColor?: boolean,
};

type FontAtlas = {|
  textureData: Uint8Array,
  textureWidth: number,
  textureHeight: number,
  charInfo: {
    [char: string]: {|
      x: number,
      y: number,
      width: number,
    |},
  },
|};

// Font size used in rendering the atlas. This is independent of the `scale` of the rendered text.
const FONT_SIZE = 40;
const BUFFER = 10;
const MAX_ATLAS_WIDTH = 512;
const SDF_RADIUS = 8;
const CUTOFF = 0.25;
const OUTLINE_CUTOFF = 0.5;
const DEFAULT_COLOR = Object.freeze({ r: 1, g: 0, b: 1, a: 1 });
const DEFAULT_OUTLINE_COLOR = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });

const BG_COLOR_LIGHT = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });
const BG_COLOR_DARK = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });

// Build a single font atlas: a texture containing all characters and position/size data for each character.
const createMemoizedBuildAtlas = () =>
  memoizeOne((charSet: Set<string>): FontAtlas => {
    const tinySDF = new TinySDF(FONT_SIZE, BUFFER, SDF_RADIUS, CUTOFF, "sans-serif", "normal");

    const fontStyle = `${FONT_SIZE}px sans-serif`;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = fontStyle;

    let textureWidth = 0;
    const rowHeight = FONT_SIZE + 2 * BUFFER;
    const charInfo = {};

    // Measure and assign positions to all characters
    let x = 0;
    let y = 0;
    for (const char of charSet) {
      const width = ctx.measureText(char).width;
      const dx = Math.ceil(width) + 2 * BUFFER;
      if (x + dx > MAX_ATLAS_WIDTH) {
        x = 0;
        y += rowHeight;
      }
      charInfo[char] = { x, y, width };
      x += dx;
      textureWidth = Math.max(textureWidth, x);
    }

    const textureHeight = y + rowHeight;
    const textureData = new Uint8Array(textureWidth * textureHeight);

    // Use tiny-sdf to create SDF images for each character and copy them into a single texture
    for (const char of charSet) {
      const { x, y } = charInfo[char];
      const data = tinySDF.draw(char);
      for (let i = 0; i < tinySDF.size; i++) {
        for (let j = 0; j < tinySDF.size; j++) {
          // if this character is near the right edge, we don't actually copy the whole square of data
          if (x + j < textureWidth) {
            textureData[textureWidth * (y + i) + x + j] = data[i * tinySDF.size + j];
          }
        }
      }
    }

    return { textureData, textureWidth, textureHeight, charInfo };
  }, isEqual);

const vert = `
  precision mediump float;

  #WITH_POSE

  uniform mat4 projection, view, billboardRotation;
  uniform bool billboard;
  uniform float fontSize;
  uniform float srcHeight;
  uniform vec2 atlasSize;
  uniform vec3 scale;

  attribute vec2 texCoord;
  attribute vec2 position;

  attribute vec2 srcOffset;
  attribute float srcWidth;
  attribute vec2 destOffset;

  uniform vec2 alignmentOffset;

  varying vec2 vTexCoord;
  void main () {
    vec2 srcSize = vec2(srcWidth, srcHeight);
    vec3 markerSpacePos = scale * vec3((destOffset + position * srcSize + alignmentOffset) / fontSize, 0);
    vec3 pos;
    if (billboard) {
      pos = applyPosePosition((billboardRotation * vec4(markerSpacePos, 1)).xyz);
    } else {
      pos = applyPose(markerSpacePos);
    }
    gl_Position = projection * view * vec4(pos, 1);
    vTexCoord = (srcOffset + texCoord * srcSize) / atlasSize;
  }
`;

const frag = `
  #extension GL_OES_standard_derivatives : enable
  precision mediump float;
  uniform mat4 projection;
  uniform sampler2D atlas;
  uniform float outlineCutoff;
  uniform float cutoff;
  uniform bool enableOutline;
  uniform vec4 foregroundColor;
  uniform vec4 outlineColor;
  varying vec2 vTexCoord;
  void main() {
    float dist = texture2D(atlas, vTexCoord).a;

    // fwidth(dist) is used to provide some anti-aliasing. However it's currently only used
    // between outline and text, not on the outer border, because the alpha blending and
    // depth test don't work together nicely for partially-transparent pixels.
    if (enableOutline) {
      float screenSize = fwidth(vTexCoord.x);
      float edgeStep = smoothstep(1.0 - cutoff - fwidth(dist), 1.0 - cutoff, dist);
      gl_FragColor = mix(outlineColor, foregroundColor, edgeStep);
      gl_FragColor.a *= step(1.0 - outlineCutoff, dist);
    } else {
      gl_FragColor = foregroundColor;
      gl_FragColor.a *= step(1.0 - cutoff, dist);
    }

    if (gl_FragColor.a == 0.) {
      discard;
    }
  }
`;

function makeTextCommand() {
  // Keep the set of rendered characters around so we don't have to rebuild the font atlas too often.
  const charSet = new Set();
  const memoizedBuildAtlas = createMemoizedBuildAtlas();

  const command = (regl: any) => {
    const atlasTexture = regl.texture();

    const drawText = regl(
      withPose({
        depth: defaultDepth,
        blend: defaultBlend,
        primitive: "triangle strip",
        vert,
        frag,
        uniforms: {
          atlas: atlasTexture,
          atlasSize: () => [atlasTexture.width, atlasTexture.height],
          fontSize: FONT_SIZE,
          cutoff: CUTOFF,
          outlineCutoff: OUTLINE_CUTOFF,
          srcHeight: FONT_SIZE + 2 * BUFFER,
          alignmentOffset: regl.prop("alignmentOffset"),
          billboard: regl.prop("billboard"),
          scale: (ctx, props) => (shouldConvert(props.scale) ? pointToVec3(props.scale) : props.scale),

          foregroundColor: (ctx, props) => toRGBA(props.colors?.[0] || props.color),
          outlineColor: (ctx, props) => toRGBA(props.colors?.[1] || DEFAULT_OUTLINE_COLOR),
          enableOutline: (ctx, props) => props.colors?.[1] != null,
        },
        instances: regl.prop("instances"),
        count: 4,
        attributes: {
          position: [[0, 0], [0, -1], [1, 0], [1, -1]],
          texCoord: [[0, 0], [0, 1], [1, 0], [1, 1]], // flipped
          srcOffset: (ctx, props) => ({ buffer: regl.buffer(props.srcOffsets), divisor: 1 }),
          destOffset: (ctx, props) => ({ buffer: regl.buffer(props.destOffsets), divisor: 1 }),
          srcWidth: (ctx, props) => ({ buffer: regl.buffer(props.srcWidths), divisor: 1 }),
        },
      })
    );

    return (props: $ReadOnlyArray<TextMarker & { billboard?: boolean }>) => {
      const prevNumChars = charSet.size;
      for (const { text } of props) {
        for (const char of text) {
          charSet.add(char);
        }
      }

      const { textureData, textureWidth, textureHeight, charInfo } = memoizedBuildAtlas(
        new Set(charSet) // copy charSet since a reference is kept for memoization
      );

      // re-upload texture only if characters were added
      if (charSet.size !== prevNumChars) {
        atlasTexture({
          data: textureData,
          width: textureWidth,
          height: textureHeight,
          format: "alpha",
          wrap: "clamp",
          mag: "linear",
          min: "linear",
        });
      }

      let totalInstances = 0;
      const estimatedInstances = props.reduce((sum, marker) => sum + marker.text.length, 0);
      const destOffsets = new Float32Array(estimatedInstances * 2);
      const srcWidths = new Float32Array(estimatedInstances);
      const srcOffsets = new Float32Array(estimatedInstances * 2);

      // These don't vary across characters within a marker, but the divisor can't be dynamic so we have to duplicate the data for each character.
      const alignmentOffset = new Float32Array(estimatedInstances * 2);
      const scale = new Float32Array(estimatedInstances * 3);
      const foregroundColor = new Float32Array(estimatedInstances * 4);
      const outlineColor = new Float32Array(estimatedInstances * 4);
      const enableOutline = new Uint8Array(estimatedInstances);
      const billboard = new Uint8Array(estimatedInstances);

      for (const marker of props) {
        for (const char of marker.text) {
          let totalWidth = 0;
          let x = 0;
          let y = 0;
          let markerInstances = 0;
          for (const char of marker.text) {
            if (char === "\n") {
              x = 0;
              y = FONT_SIZE;
              continue;
            }
            const info = charInfo[char];
            destOffsets[2 * (totalInstances + markerInstances) + 0] = x - BUFFER;
            destOffsets[2 * (totalInstances + markerInstances) + 1] = -(y - BUFFER);
            srcOffsets[2 * (totalInstances + markerInstances) + 0] = info.x;
            srcOffsets[2 * (totalInstances + markerInstances) + 1] = info.y;
            srcWidths[totalInstances + markerInstances] = info.width + 2 * BUFFER;
            x += info.width;
            totalWidth = Math.max(totalWidth, x);
            ++markerInstances;
          }
          const totalHeight = y + FONT_SIZE;

          let colors = marker.colors;
          if (command.autoBackgroundColor && (!colors || colors.length !== 2)) {
            const foregroundColor = colors?.[0] || marker.color || DEFAULT_COLOR;
            colors = [foregroundColor, isColorDark(foregroundColor) ? BG_COLOR_LIGHT : BG_COLOR_DARK];
          }

          for (let i = 0; i < markerInstances; i++) {
            billboard[totalInstances + i] = marker.billboard ?? true;

            alignmentOffset[2 * (totalInstances + i) + 0] = -totalWidth / 2;
            alignmentOffset[2 * (totalInstances + i) + 1] = totalHeight / 2;

            scale[3 * (totalInstances + i) + 0] = marker.scale.x;
            scale[3 * (totalInstances + i) + 1] = marker.scale.y;
            scale[3 * (totalInstances + i) + 2] = marker.scale.z;

            position[4 * (totalInstances + i) + 0] = marker.pose.position.x;
            position[4 * (totalInstances + i) + 1] = marker.pose.position.y;
            position[4 * (totalInstances + i) + 2] = marker.pose.position.z;
            position[4 * (totalInstances + i) + 3] = marker.pose.position.w;
          }
          totalInstances += markerInstances;

          return {
            billboard: marker.billboard ?? true,
            pose: marker.pose,
            color: marker.color || DEFAULT_COLOR,
            colors,
            scale: marker.scale,
            alignmentOffset: [-totalWidth / 2, totalHeight / 2],
            instances: totalInstances,
            srcOffsets,
            destOffsets,
            srcWidths,
          };
        }
      }

      drawText({
        instances: totalInstances,
      });
    };
  };
  command.autoBackgroundColor = false;
  return command;
}

export default function GLText(props: Props) {
  const [command] = useState(() => makeTextCommand());
  // HACK: Worldview doesn't provide an easy way to pass a command-level prop into the regl commands,
  // so just attach it to the command object for now.
  command.autoBackgroundColor = props.autoBackgroundColor;
  return <Command reglCommand={command} {...props} />;
}
