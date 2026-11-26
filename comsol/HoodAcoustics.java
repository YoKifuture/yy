import com.comsol.model.Model;
import com.comsol.model.util.ModelUtil;

public class HoodAcoustics {
    private static final String COMP = "comp1";
    private static final String GEOM = "geom1";
    private static final String PHYSICS = "acpr";
    private static final String JOB_DIRECTORY = "__COMSOL_JOB_DIRECTORY__";

    private static void rectangle(Model model, String tag, String width, String height, String x, String y) {
        var geom = model.component(COMP).geom(GEOM);
        var rectangle = geom.create(tag, "Rectangle");
        rectangle.set("size", new String[]{width, height});
        rectangle.set("pos", new String[]{x, y});
    }

    private static void selectEnd(Model model, String tag, String x) {
        var box = model.component(COMP).selection().create(tag, "Box");
        box.geom(GEOM, 1);
        box.set("condition", "inside");
        box.set("xmin", x + "-0.00001[m]");
        box.set("xmax", x + "+0.00001[m]");
        if (box.entities(1).length != 1) throw new IllegalStateException("Expected one boundary at " + tag);
    }

    private static Model build(boolean branch) {
        Model model = ModelUtil.create(branch ? "Resonator" : "Reference");
        model.label(branch ? "Side-branch Helmholtz.mph" : "Straight duct reference.mph");
        model.param().set("ductL", "360[mm]");
        model.param().set("ductH", "65[mm]");
        model.param().set("neckW", "12[mm]");
        model.param().set("neckH", "20[mm]");
        model.param().set("cavityW", "97[mm]");
        model.param().set("cavityH", "70[mm]");
        model.param().set("airRho", "1.204[kg/m^3]");
        model.param().set("airC", "343[m/s]");
        model.component().create(COMP, true);
        var component = model.component(COMP);
        var geom = component.geom().create(GEOM, 2);
        geom.lengthUnit("m");
        rectangle(model, "duct", "ductL", "ductH", "0", "0");
        if (branch) {
            rectangle(model, "neck", "neckW", "neckH", "(ductL-neckW)/2", "ductH");
            rectangle(model, "cavity", "cavityW", "cavityH", "(ductL-cavityW)/2", "ductH+neckH");
        }
        geom.run();
        selectEnd(model, "inlet", "0[m]");
        selectEnd(model, "outlet", "ductL");

        var air = component.material().create("air", "Common");
        air.label("Air at 20 C, no mean flow");
        air.propertyGroup("def").set("density", "airRho");
        air.propertyGroup("def").set("soundspeed", "airC");
        var physics = component.physics().create(PHYSICS, "PressureAcoustics", GEOM);
        for (int index = 1; index <= 2; index++) {
            var port = physics.create("port" + index, "Port", 1);
            port.selection().named(index == 1 ? "inlet" : "outlet");
            port.set("PortType", "Slit");
            port.set("m_slit", "0");
            port.set("PortExcitation", index == 1 ? "on" : "off");
            if (index == 1) port.set("pamp", "1[Pa]");
        }
        var mesh = component.mesh().create("mesh1");
        mesh.create("ftri1", "FreeTri");
        mesh.feature("size").set("custom", "on");
        mesh.feature("size").set("hmax", "0.006[m]");
        mesh.feature("size").set("hmin", "0.0015[m]");
        mesh.run();
        var study = model.study().create("std1");
        study.create("freq", "Frequency");
        study.feature("freq").set("plist", "range(150,5,950)");
        study.run();
        return model;
    }

    private static void writeResults(Model model, String output) {
        var evaluation = model.result().numerical().create("globalTL", "EvalGlobal");
        evaluation.set("data", "dset1");
        evaluation.set("expr", new String[]{"freq", "10*log10(acpr.port1.P_in/acpr.port2.P_out)"});
        double[][] rows = evaluation.getReal();
        if (rows.length != 2 || rows[0].length < 3 || rows[0].length != rows[1].length) {
            throw new IllegalStateException("Frequency sweep export has unexpected dimensions");
        }
        for (int i = 0; i < rows[0].length; i++) {
            if (!Double.isFinite(rows[0][i]) || !Double.isFinite(rows[1][i])) {
                throw new IllegalStateException("The computed sweep contains a non-finite value");
            }
        }
        var table = model.result().table().create("tblTL", "Table");
        evaluation.set("table", "tblTL");
        evaluation.setResult();
        table.save(output);
    }

    public static void main(String[] args) throws java.io.IOException {
        for (boolean branch : new boolean[]{false, true}) {
            String name = branch ? "side-branch" : "reference";
            Model model = build(branch);
            writeResults(model, JOB_DIRECTORY + "/" + name + ".csv");
            model.save(JOB_DIRECTORY + "/" + name + ".mph");
            ModelUtil.remove(model.tag());
        }
    }
}
