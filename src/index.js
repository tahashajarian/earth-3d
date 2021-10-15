import * as THREE from 'three';
import Stats from "three/examples/jsm/libs/stats.module";
import vertexShader from './shaders/vertex.glsl'
import fragmentShader from './shaders/fragment.glsl'
import vertexShaderAtmespher from './shaders/vertexAtmespher.glsl'
import fragmentShaderAtmespher from './shaders/fragmentAtmespher.glsl'
import gsap from 'gsap';




class World {
  constructor() {
    this.init()
  }

  init() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000)
    this.camera.position.z = 15
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
    })
    this.mouse = {
      x: undefined, y: undefined
    }
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.stats = Stats();
    this.appendToDom()
    this.createEarth()
    this.addStarts()
    this.initEvents()
    this.createFog();
    this.createLight()
    this.animate()
  }

  createEarth() {
    this.earth = new THREE.Mesh(
      new THREE.SphereGeometry(5, 50, 50),
      // new THREE.MeshBasicMaterial({
      //   // color: 0xff0000
      //   map: new THREE.TextureLoader().load(
      //     'assets/earth.jpg'
      //   )
      // }),
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          globeTexture: {
            value: new THREE.TextureLoader().load(
              'assets/earth.jpg'
            )
          }
        }
      })
    )
    this.atmespher = new THREE.Mesh(
      new THREE.SphereGeometry(5, 50, 50),
      // new THREE.MeshBasicMaterial({
      //   // color: 0xff0000
      //   map: new THREE.TextureLoader().load(
      //     'assets/earth.jpg'
      //   )
      // }),
      new THREE.ShaderMaterial({
        vertexShader: vertexShaderAtmespher,
        fragmentShader: fragmentShaderAtmespher,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        uniforms: {
          globeTexture: {
            value: new THREE.TextureLoader().load(
              'assets/earth.jpg'
            )
          }
        }
      })
    )

    const materialClouds = new THREE.MeshLambertMaterial({

      map: new THREE.TextureLoader().load("assets/clouds.png"),
      transparent: true
    });

    this.meshClouds = new THREE.Mesh(new THREE.SphereGeometry(5, 50, 50), materialClouds);
    this.meshClouds.scale.set(1.02, 1.02, 1.02);
    this.meshClouds.rotation.z = 0.41;
    // this.scene.add(meshClouds);


    this.atmespher.scale.set(1.2, 1.2, 1.2);
    this.earthGroup = new THREE.Group();
    this.earthGroup.add(this.earth, this.atmespher, this.meshClouds)
    this.scene.add(this.earthGroup)
    // this.scene.add(this.earth)
    // this.scene.add(this.atmespher)
  }

  createLight() {
    this.dirLight = new THREE.HemisphereLight(0xffffff);
    this.dirLight.position.set(-1, 0, 1).normalize();
    this.scene.add(this.dirLight);
  }

  addStarts() {
    const startGeometry = new THREE.BufferGeometry();
    const startMaterial = new THREE.PointsMaterial({
      color: 0xffffff
    })
    const starVertices = []

    for (let i = 0; i < 10000; i++) {
      const x = (Math.random() - 0.5) * 2000;
      const y = (Math.random() - 0.5) * 2000;
      const z = -(Math.random()) * 3500;
      starVertices.push(x, y, z)
    }
    startGeometry.setAttribute(
      'position', new THREE.Float32BufferAttribute(starVertices, 3)
    )
    const starts = new THREE.Points(startGeometry, startMaterial);
    this.scene.add(starts)
  }

  createFog() {
    // this.scene.fog = new THREE.Fog(0xcce0ff, 100, 1000);
  }

  initEvents() {
    window.addEventListener(
      "resize",
      this.onWindowResize.bind(this),
      false
    );
    window.addEventListener(
      "mousemove",
      this.onMouseOver.bind(this),
      false
    );
  }

  appendToDom() {
    document.body.appendChild(this.renderer.domElement)
    document.body.appendChild(this.stats.dom);
  }

  animate() {
    requestAnimationFrame(() => {
      this.animate();
      this.stats.update();
    })

    this.renderer.render(this.scene, this.camera)
    this.earth.rotation.x += 0.001;
    this.earth.rotation.y += 0.001;
    this.meshClouds.rotation.x += 0.002;
    this.meshClouds.rotation.y += 0.002;
    //
    // this.earthGroup.rotation.x = this.mouse.y
    gsap.to(
      this.earthGroup.rotation, {
      y: this.mouse.x * 0.5,
      x: -this.mouse.y * 0.5,
      duration: 2
    }
    )
    this.earthGroup.rotation.y = this.mouse.x * 0.5
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  onMouseOver({ clientX, clientY }) {
    this.mouse = {
      x: (clientX / innerWidth) * 2 - 1,
      y: (clientY / innerHeight) * 2 + 1
    }
  }

}

const site = new World();


