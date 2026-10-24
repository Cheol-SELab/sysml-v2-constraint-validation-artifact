package bench;

import java.io.FileWriter;
import java.io.IOException;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.shacl.ShaclValidator;
import org.apache.jena.shacl.Shapes;
import org.apache.jena.shacl.ValidationReport;
import org.apache.jena.shacl.validation.ReportEntry;

/**
 * JVM SHACL baseline (round-2 review item N2): Apache Jena SHACL on the same Turtle and shapes as pySHACL.
 *
 * usage: java -jar bench-jena-shacl.jar <shapes.ttl> <data.ttl> <out.json> [reps] [warmup]
 *
 * Parsing and shape compilation are timed separately; validation runs `warmup` times untimed and `reps`
 * times timed on the same in-memory graph (JIT warm-up), the median is reported.
 */
public class RunJena {
    static double now() { return System.nanoTime() / 1e6; }

    static String esc(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    static String term(Node n) {
        if (n == null) return null;
        if (n.isURI()) return n.getURI();
        if (n.isBlank()) return "_:" + n.getBlankNodeLabel();
        if (n.isLiteral()) return n.getLiteralLexicalForm();
        return n.toString();
    }

    public static void main(String[] a) throws IOException {
        String shapesF = a[0], dataF = a[1], outF = a[2];
        int reps = a.length > 3 ? Integer.parseInt(a[3]) : 5;
        int warmup = a.length > 4 ? Integer.parseInt(a[4]) : 2;
        StringBuilder out = new StringBuilder("{");
        String file = dataF.replaceAll(".*[\\\\/]", "");
        out.append("\"engine\":\"jena-shacl\",\"version\":").append(esc(org.apache.jena.Jena.VERSION))
           .append(",\"java\":").append(esc(System.getProperty("java.version")))
           .append(",\"file\":").append(esc(file)).append(",\"supportsSparql\":true");
        try {
            double t0 = now();
            Graph shapesGraph = RDFDataMgr.loadGraph(shapesF);
            Graph data = RDFDataMgr.loadGraph(dataF);
            double parseMs = now() - t0;
            t0 = now();
            Shapes shapes = Shapes.parse(shapesGraph);
            double prepareMs = now() - t0;
            ValidationReport report = null;
            for (int i = 0; i < warmup; i++) report = ShaclValidator.get().validate(shapes, data);
            List<Double> samples = new ArrayList<>();
            for (int i = 0; i < reps; i++) {
                t0 = now();
                report = ShaclValidator.get().validate(shapes, data);
                samples.add(now() - t0);
            }
            List<Double> s = new ArrayList<>(samples);
            Collections.sort(s);
            int m = s.size() / 2;
            double med = s.size() % 2 == 1 ? s.get(m) : (s.get(m - 1) + s.get(m)) / 2;
            out.append(",\"parseMs\":").append(parseMs).append(",\"prepareMs\":").append(prepareMs)
               .append(",\"dataTriples\":").append(data.size()).append(",\"warmup\":").append(warmup)
               .append(",\"validateSamplesMs\":").append(samples).append(",\"validateMs\":").append(med)
               .append(",\"conforms\":").append(report.conforms()).append(",\"results\":[");
            boolean first = true;
            for (ReportEntry e : report.getEntries()) {
                if (!first) out.append(',');
                first = false;
                out.append("{\"focus\":").append(esc(term(e.focusNode())))
                   .append(",\"shape\":").append(esc(term(e.source())))
                   .append(",\"value\":").append(esc(term(e.value()))).append('}');
            }
            out.append(']');
            System.out.printf("jena-shacl %s: validate %.1f ms, %d results, parse %.0f ms%n", file, med, report.getEntries().size(), parseMs);
        } catch (Throwable t) {
            out.append(",\"error\":").append(esc(t.toString()));
            System.out.println("jena-shacl " + file + ": ERROR " + t);
        }
        out.append('}');
        try (Writer w = new FileWriter(outF, java.nio.charset.StandardCharsets.UTF_8)) { w.write(out.toString()); }
    }
}
