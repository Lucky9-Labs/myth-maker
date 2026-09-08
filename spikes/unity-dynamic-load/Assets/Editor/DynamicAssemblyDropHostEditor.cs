using UnityEditor;
using UnityEngine;

namespace MythMaker.DynamicAssemblySpike.Editor
{
    [CustomEditor(typeof(DynamicAssemblyDropHost))]
    public sealed class DynamicAssemblyDropHostEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            SerializedProperty assembly = serializedObject.FindProperty("pluginAssembly");
            SerializedProperty sha256 = serializedObject.FindProperty("expectedSha256");
            EditorGUI.BeginChangeCheck();
            EditorGUILayout.PropertyField(assembly);
            if (EditorGUI.EndChangeCheck())
            {
                TextAsset selected = assembly.objectReferenceValue as TextAsset;
                sha256.stringValue = selected == null ? string.Empty : DynamicAssemblyLoader.ComputeSha256(selected.bytes);
            }
            EditorGUILayout.LabelField("SHA-256", string.IsNullOrEmpty(sha256.stringValue) ? "Select a .bytes payload." : sha256.stringValue, EditorStyles.wordWrappedLabel);
            EditorGUILayout.PropertyField(serializedObject.FindProperty("entrypointType"));
            EditorGUILayout.PropertyField(serializedObject.FindProperty("entrypointMethod"));
            EditorGUILayout.PropertyField(serializedObject.FindProperty("loadOnStart"));
            serializedObject.ApplyModifiedProperties();
        }
    }
}
