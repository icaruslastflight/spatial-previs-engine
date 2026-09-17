// Volumetric Beam Raymarching in WGSL
// Beer-Lambert absorption & soft-fading

struct VolumetricUniforms {
    beamOrigin: vec3<f32>,
    beamDirection: vec3<f32>,
    beamColor: vec3<f32>,
    beamIntensity: f32,
    beamAngle: f32, // Cone half-angle
    attenuation: f32,
    maxDistance: f32,
    cameraPosition: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: VolumetricUniforms;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
}

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    // ... camera matrix transforms assumed injected by Three.js WebGPURenderer
    // For now we export the core volumetric function.
    out.world_pos = in.position;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let rayDir = normalize(in.world_pos - uniforms.cameraPosition);
    let startPos = uniforms.cameraPosition;
    
    var transmittance: f32 = 1.0;
    var scatteredLight: vec3<f32> = vec3<f32>(0.0);
    
    let stepSize: f32 = 0.1;
    let maxSteps: i32 = 50;
    
    var currentPos = in.world_pos;
    
    for (var i = 0; i < maxSteps; i++) {
        let distToBeam = length(cross(currentPos - uniforms.beamOrigin, uniforms.beamDirection));
        let distAlongBeam = dot(currentPos - uniforms.beamOrigin, uniforms.beamDirection);
        
        if (distAlongBeam > 0.0 && distAlongBeam < uniforms.maxDistance) {
            let coneRadius = distAlongBeam * tan(uniforms.beamAngle);
            if (distToBeam < coneRadius) {
                // Inside the beam cone
                // Beer-Lambert law: T = e^(-attenuation * distance)
                let density = smoothstep(coneRadius, 0.0, distToBeam);
                let extinction = uniforms.attenuation * density;
                
                let stepTransmittance = exp(-extinction * stepSize);
                let stepScattering = uniforms.beamColor * uniforms.beamIntensity * density * (1.0 - stepTransmittance) / extinction;
                
                scatteredLight = scatteredLight + transmittance * stepScattering;
                transmittance = transmittance * stepTransmittance;
            }
        }
        currentPos = currentPos + rayDir * stepSize;
    }
    
    return vec4<f32>(scatteredLight, 1.0 - transmittance);
}
