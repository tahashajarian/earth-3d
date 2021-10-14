uniform sampler2D globeTexture;
varying vec2 vUV;
varying vec3 vertexNormal;

void main() {
  float intensity = 1.05 - dot(vertexNormal, vec3(00, 00, 01));
  vec3 atomosphere = vec3(0.3, 0.6, 1.0) * pow(intensity, 1.5);
  gl_FragColor = vec4(atomosphere + texture2D(globeTexture, vUV).xyz, 1);
}