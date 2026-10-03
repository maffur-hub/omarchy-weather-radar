// Make the near-black missing-data in a GIBS true-colour tile transparent, so
// the layer beneath shows through. Qt 6 will not compile inline GLSL for a
// ShaderEffect, so this is compiled to blackmask.frag.qsb and shipped:
//
//   qsb --glsl "100 es,120,150" --hlsl 50 --msl 12 \
//       -o shaders/blackmask.frag.qsb shaders/blackmask.frag
//
// The thresholds sit in the empty band between the opaque-black gaps in a
// GIBS tile (measured below 0.06) and the darkest real scene pixels (above
// 0.09).
#version 440
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
};
layout(binding = 1) uniform sampler2D source;
void main() {
    vec4 c = texture(source, qt_TexCoord0);
    float m = max(c.r, max(c.g, c.b));
    float a = smoothstep(0.02, 0.08, m);
    fragColor = vec4(c.rgb * a, c.a * a) * qt_Opacity;
}
