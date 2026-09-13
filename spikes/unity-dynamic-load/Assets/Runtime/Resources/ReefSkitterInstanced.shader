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

            struct appdata { float4 vertex : POSITION; float3 normal : NORMAL; uint instanceID : SV_InstanceID; };
            struct v2f { float4 position : SV_POSITION; float light : TEXCOORD0; };
            StructuredBuffer<float4x4> _InstanceMatrices;
            float4x4 _PartMatrix;
            fixed4 _Color;

            v2f vert(appdata input)
            {
                v2f output;
                float4x4 model = mul(_InstanceMatrices[input.instanceID], _PartMatrix);
                float4 world = mul(model, input.vertex);
                output.position = mul(UNITY_MATRIX_VP, world);
                float3 normal = normalize(mul((float3x3)model, input.normal));
                output.light = saturate(dot(normal, normalize(float3(.35, .8, -.45))) * .55 + .45);
                return output;
            }

            fixed4 frag(v2f input) : SV_Target { return fixed4(_Color.rgb * input.light, 1); }
            ENDCG
        }
    }
}
