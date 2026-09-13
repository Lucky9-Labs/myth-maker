Shader "MythMaker/ReefSkitterInstanced"
{
    Properties { _Color ("Color", Color) = (0.05, 0.2, 0.22, 1) }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        Cull Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "UnityCG.cginc"

            struct appdata { float4 vertex : POSITION; float3 normal : NORMAL; uint4 joints : BLENDINDICES; float4 weights : BLENDWEIGHT; uint instanceID : SV_InstanceID; };
            struct v2f { float4 position : SV_POSITION; float light : TEXCOORD0; };
            StructuredBuffer<float4> _InstanceRoots;
            StructuredBuffer<float4> _InstanceAnimation;
            StructuredBuffer<float4x4> _BoneAnimationSamples;
            int _JointCount;
            int _SamplesPerClip;
            fixed4 _Color;

            v2f vert(appdata input)
            {
                v2f output;
                float4 selector = _InstanceAnimation[input.instanceID];
                uint clip = (uint)selector.x;
                float phase = selector.z >= 2.0 ? 0.0 : saturate(selector.y);
                uint sample = (uint)round(phase * (_SamplesPerClip - 1));
                uint sampleBase = (clip * (uint)_SamplesPerClip + sample) * (uint)_JointCount;
                float4x4 skin = _BoneAnimationSamples[sampleBase + input.joints.x] * input.weights.x
                    + _BoneAnimationSamples[sampleBase + input.joints.y] * input.weights.y
                    + _BoneAnimationSamples[sampleBase + input.joints.z] * input.weights.z
                    + _BoneAnimationSamples[sampleBase + input.joints.w] * input.weights.w;
                float4 root = _InstanceRoots[input.instanceID];
                float sine, cosine; sincos(root.w, sine, cosine);
                float4 partPosition = mul(skin, input.vertex);
                float3 world = float3(cosine * partPosition.x + sine * partPosition.z, partPosition.y, -sine * partPosition.x + cosine * partPosition.z) + root.xyz;
                output.position = mul(UNITY_MATRIX_VP, float4(world, 1));
                float3 partNormal = normalize(mul((float3x3)skin, input.normal));
                float3 normal = float3(cosine * partNormal.x + sine * partNormal.z, partNormal.y, -sine * partNormal.x + cosine * partNormal.z);
                output.light = saturate(dot(normal, normalize(float3(.35, .8, -.45))) * .55 + .45);
                return output;
            }

            fixed4 frag(v2f input) : SV_Target { return fixed4(_Color.rgb * input.light, 1); }
            ENDCG
        }
    }
}
