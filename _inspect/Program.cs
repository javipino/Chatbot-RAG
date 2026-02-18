using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;

// Use MetadataLoadContext to avoid loading dependencies
var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
var nugetBase = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages");
var extraDlls = new[] {
    Path.Combine(nugetBase, "azure.core", "1.49.0", "lib", "net8.0", "Azure.Core.dll"),
    Path.Combine(nugetBase, "system.clientmodel", "1.8.0", "lib", "net8.0", "System.ClientModel.dll"),
    Path.Combine(nugetBase, "system.memory.data", "9.0.0", "lib", "net8.0", "System.Memory.Data.dll"),
};
var allDlls = Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { args[0] }).Concat(extraDlls.Where(File.Exists));
var resolver = new PathAssemblyResolver(allDlls);
using var mlc = new MetadataLoadContext(resolver);
var asm = mlc.LoadFromAssemblyPath(args[0]);

// Find ServiceVersion enum
var svTypes = asm.GetTypes().Where(t => t.Name.Contains("ServiceVersion")).ToArray();
foreach (var t in svTypes) {
    Console.WriteLine($"TYPE: {t.FullName}");
    foreach (var f in t.GetFields()) {
        if (f.IsLiteral) {
            try { Console.WriteLine($"  {f.Name} = {f.GetRawConstantValue()}"); } catch { }
        }
    }
}

// Look for CreateAgentAsync method details
var adminType = asm.GetTypes().FirstOrDefault(t => t.Name == "PersistentAgentsAdministrationClient");
if (adminType != null) {
    Console.WriteLine($"\nTYPE: {adminType.FullName}");
    var createMethods = adminType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
        .Where(m => m.Name.Contains("CreateAgent"));
    foreach (var m in createMethods) {
        var parms = string.Join(", ", m.GetParameters().Select(p => $"{p.ParameterType.Name} {p.Name}"));
        Console.WriteLine($"  {m.Name}({parms})");
    }
}

// Look for PersistentAgentsClient details
var clientType = asm.GetTypes().FirstOrDefault(t => t.Name == "PersistentAgentsClient");
if (clientType != null) {
    Console.WriteLine($"\nTYPE: {clientType.FullName}");
    Console.WriteLine($"  BaseType: {clientType.BaseType?.FullName}");
    foreach (var p in clientType.GetProperties(BindingFlags.Public | BindingFlags.Instance)) {
        Console.WriteLine($"  Prop: {p.Name} ({p.PropertyType.Name})");
    }
    var ctors = clientType.GetConstructors(BindingFlags.Public | BindingFlags.Instance);
    foreach (var c in ctors) {
        var parms = string.Join(", ", c.GetParameters().Select(p => $"{p.ParameterType.Name} {p.Name}"));
        Console.WriteLine($"  Ctor({parms})");
    }
}

// Find any string fields mentioning api-version, version, or date patterns
Console.WriteLine("\n--- Constant strings ---");
foreach (var t in asm.GetTypes().OrderBy(t => t.FullName)) {
    foreach (var f in t.GetFields(BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)) {
        if (f.IsLiteral && f.FieldType.FullName == "System.String") {
            try {
                var val = f.GetRawConstantValue()?.ToString() ?? "";
                if (val.Contains("2025") || val.Contains("2024") || val.Contains("api") || val.Contains("version") || val.Contains("assistants") || val.Contains("/agents"))
                    Console.WriteLine($"  {t.Name}.{f.Name} = {val}");
            } catch { }
        }
    }
}
