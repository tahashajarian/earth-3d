varying vec2 vUV;
varying vec3 vertexNormal;

void main() {
  vUV = uv;
  vertexNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}